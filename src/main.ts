import { App, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { GoogleAuth } from './auth';
import { DriveClient } from './drive';
import { CloseResult, CloseSync, NativeCloseEvent } from './close';
import { Report, SyncEngine } from './engine';
import { ObsidianLocal, saveOpenEditors } from './local';
import { CancelledError, ChangedError, DEFAULT_SETTINGS, RECOVERY, Settings, SyncError, SyncState, emptyState, safePath } from './model';
import { CloseReceipt, StateStore, acquireLock } from './storage';
import { SyncProgress, describeProgress } from './progress';
import { SyncProgressPanel, SyncProgressPopup } from './progress-view';

interface ElectronShell { shell: { openExternal(url: string): Promise<void>; openPath(path: string): Promise<string> } }
const electron = (): ElectronShell => require('electron') as ElectronShell;
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'Onbekende fout.';
interface NativeWindow {
  on(event: 'close', listener: (event: NativeCloseEvent) => void): void;
  removeListener(event: 'close', listener: (event: NativeCloseEvent) => void): void;
}

export default class DriveVaultSync extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS, exclude: [] };
  state: SyncState = emptyState();
  auth!: GoogleAuth;
  busy = false;
  blocked = '';
  private store!: StateStore;
  private basePath = '';
  private status!: HTMLElement;
  private timer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private disposed = false;
  private nextAuto = 0;
  private failures = 0;
  private logLines: string[] = [];
  private lastError = '';
  private operation?: Promise<unknown>;
  private closeSync?: CloseSync;
  private closeReceipt?: CloseReceipt;
  private closeOverlay?: HTMLElement;
  private closeCountdown?: ReturnType<typeof setInterval>;
  private progressPopup?: SyncProgressPopup;
  private closeProgressPanel?: SyncProgressPanel;
  private syncProgress?: SyncProgress;
  private progressPaint = 0;
  closeBridgeAvailable = false;

  async onload(): Promise<void> {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter) || !this.app.secretStorage) throw new Error('Drive Vault Sync vereist Obsidian Desktop 1.11.4 of nieuwer.');
    this.basePath = this.app.vault.adapter.getBasePath();
    const stored = await this.loadData() as Partial<Settings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      clientId: typeof stored?.clientId === 'string' ? stored.clientId : '',
      rootId: typeof stored?.rootId === 'string' ? stored.rootId : '',
      intervalSeconds: Math.min(3600, Math.max(30, Number(stored?.intervalSeconds) || 120)),
      debounceSeconds: Math.min(300, Math.max(3, Number(stored?.debounceSeconds) || 8)),
      autoSync: typeof stored?.autoSync === 'boolean' ? stored.autoSync : true, syncDeletes: stored?.syncDeletes === true,
      syncOnClose: typeof stored?.syncOnClose === 'boolean' ? stored.syncOnClose : true,
      closeTimeoutSeconds: Math.min(120, Math.max(5, Number(stored?.closeTimeoutSeconds) || 30)),
      exclude: Array.isArray(stored?.exclude) ? stored.exclude.filter((v): v is string => typeof v === 'string') : [],
      // Vault-local identifier is not an OAuth token.
      secretId: typeof stored?.secretId === 'string' && /^[a-z0-9-]+$/u.test(stored.secretId) ? stored.secretId : 'drive-vault-sync-' + randomUUID()
    };
    await this.saveData(this.settings);
    const pluginDir = this.manifest.dir;
    if (!pluginDir) throw new Error('Pluginmap kon niet worden vastgesteld.');
    this.store = new StateStore(this.basePath, path.join(this.basePath, pluginDir, 'sync-state.json'));
    this.closeReceipt = new CloseReceipt(this.basePath, path.join(this.basePath, pluginDir, 'close-sync.json'));
    try { this.state = this.store.load(); }
    catch (error) { this.blocked = errorText(error); }
    this.auth = new GoogleAuth(this.settings.clientId, this.settings.secretId, this.app.secretStorage);
    this.installCloseSync();
    try {
      if (this.closeReceipt.pending()) new Notice('De vorige afsluitsync is niet bevestigd. Lokale bestanden blijven bewaard; laat Drive opnieuw synchroniseren.', 15_000);
    } catch (error) { this.log(errorText(error)); }
    this.status = this.addStatusBarItem();
    this.status.addClass('drive-vault-sync-status');
    this.status.setAttribute('role', 'button'); this.status.setAttribute('tabindex', '0');
    this.registerDomEvent(this.status, 'click', () => void this.sync(false, true));
    this.registerDomEvent(this.status, 'keydown', event => { if (event.key === 'Enter') void this.sync(false, true); });
    this.renderStatus();
    this.addRibbonIcon('cloud-download', 'Drive Vault Sync: nu synchroniseren', () => void this.sync(false, true));
    this.addCommand({ id: 'sync-now', name: 'Nu synchroniseren (eerst downloaden)', callback: () => void this.sync(false, true) });
    this.addCommand({ id: 'preview', name: 'Synchronisatie vooraf bekijken', callback: () => void this.sync(true, true) });
    this.addCommand({ id: 'stop', name: 'Lopende synchronisatie stoppen', callback: () => this.stop() });
    this.addCommand({ id: 'pause', name: 'Automatische synchronisatie pauzeren of hervatten', callback: () => void this.setPaused(this.settings.autoSync) });
    this.addCommand({ id: 'log', name: 'Activiteit en laatste fout bekijken', callback: () => this.showLog() });
    this.addCommand({ id: 'progress', name: 'Synchronisatievoortgang bekijken', callback: () => this.showSyncProgress() });
    this.addCommand({ id: 'recovery', name: 'Herstelkopieën openen', callback: () => void this.openRecovery() });
    this.addSettingTab(new DriveSettings(this.app, this));
    const changed = (): void => this.schedule();
    this.registerEvent(this.app.vault.on('create', changed));
    this.registerEvent(this.app.vault.on('modify', changed));
    this.registerEvent(this.app.vault.on('delete', changed));
    this.registerEvent(this.app.vault.on('rename', changed));
    this.registerDomEvent(window, 'online', () => { this.nextAuto = 0; this.schedule(); });
    this.registerDomEvent(window, 'focus', () => this.schedule());
    this.registerDomEvent(document, 'visibilitychange', () => { if (!document.hidden) this.schedule(); });
    this.timer = setInterval(() => {
      if (Date.now() >= this.nextAuto) void this.sync(false, false);
    }, 15_000);
    this.registerInterval(this.timer as unknown as number);
    this.app.workspace.onLayoutReady(() => { if (!this.disposed) this.schedule(); });
  }
  onunload(): void {
    this.disposed = true; this.closeSync?.dispose(); this.hideCloseProgress(); this.stop(); this.auth?.cancel();
    this.progressPopup?.dispose();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
  }
  private renderStatus(): void {
    if (!this.status) return;
    const progress = this.syncProgress ? describeProgress(this.syncProgress) : undefined;
    const runningText = progress ? `Drive: ${progress.title}${progress.percent === undefined ? '…' : ` ${progress.percent}%`}` : 'Drive: synchroniseren…';
    this.status.setText(this.closeSync?.holding ? 'Drive: opslaan vóór afsluiten…' : this.busy ? runningText : this.blocked || this.lastError ? 'Drive: aandacht nodig' : this.settings.autoSync ? 'Drive: gereed' : 'Drive: gepauzeerd');
    this.status.setAttribute('aria-label', this.busy ? 'Drive Vault Sync: voortgang bekijken' : 'Drive Vault Sync: nu synchroniseren');
    this.status.setAttribute('title', this.busy && progress ? `${progress.title}: ${progress.detail}${this.syncProgress?.path ? ` — ${this.syncProgress.path}` : ''}` : this.blocked || this.lastError || (this.state.lastSuccess ? `Laatste sync: ${new Date(this.state.lastSuccess).toLocaleString()}` : 'Nog geen geslaagde synchronisatie'));
  }
  log(message: string): void {
    this.logLines.push(`${new Date().toLocaleTimeString()} ${message}`);
    if (this.logLines.length > 200) this.logLines.shift();
  }
  private schedule(): void {
    if (this.busy || this.disposed || this.closeSync?.holding || !this.settings.autoSync) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = undefined; void this.sync(false, false); }, this.settings.debounceSeconds * 1000);
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); this.renderStatus(); }
  async setPaused(paused: boolean): Promise<void> {
    this.settings.autoSync = !paused;
    if (paused) { this.stop(); if (this.debounce) clearTimeout(this.debounce); }
    else { this.nextAuto = 0; this.schedule(); }
    await this.saveSettings();
    new Notice(paused ? 'Automatische Drive-sync gepauzeerd.' : 'Automatische Drive-sync hervat.');
  }
  stop(): void { this.controller?.abort(); this.auth?.cancel(); }
  private unlocked(): void { if (this.busy || this.closeSync?.holding) throw new SyncError('Stop de lopende synchronisatie voordat je deze instelling wijzigt.'); }
  private stateLock(): () => void {
    this.unlocked();
    return acquireLock(this.basePath, path.join(this.basePath, RECOVERY, 'sync.lock'));
  }
  async configure(clientId: string, root: string): Promise<void> {
    this.unlocked();
    clientId = clientId.trim();
    const rootId = parseFolderId(root);
    if (this.blocked) throw new SyncError(this.blocked);
    const unlock = this.stateLock();
    try {
      this.state = this.store.load();
      if (this.settings.clientId !== clientId) { this.auth.disconnect(); this.settings.clientId = clientId; }
      if (this.settings.rootId !== rootId || this.state.rootId !== rootId) {
        this.settings.rootId = rootId;
        this.state = emptyState(rootId); this.store.save(this.state);
        this.settings.syncDeletes = false; this.settings.autoSync = false;
      }
      this.auth = new GoogleAuth(this.settings.clientId, this.settings.secretId, this.app.secretStorage);
      this.lastError = ''; this.nextAuto = 0;
      await this.saveSettings();
    } finally { unlock(); }
  }
  async resetBaseline(): Promise<void> {
    this.unlocked();
    if (this.blocked) throw new SyncError(this.blocked);
    // StateStore keeps the previous status as .bak; content is untouched.
    const unlock = this.stateLock();
    try {
      this.state = emptyState(this.settings.rootId); this.store.save(this.state);
      this.settings.syncDeletes = false; this.settings.autoSync = false;
      await this.saveSettings();
    } finally { unlock(); }
    new Notice('Koppeling begint opnieuw. Verwijderingen en automatische sync staan uit. Bekijk eerst het synchronisatievoorstel.');
  }
  async login(): Promise<void> {
    this.unlocked(); this.busy = true; this.renderStatus();
    const operation = this.auth.login(url => electron().shell.openExternal(url)); this.operation = operation;
    try { await operation; new Notice('Google-aanmelding opgeslagen. Bekijk nu het synchronisatievoorstel.'); }
    finally { if (this.operation === operation) this.operation = undefined; this.busy = false; this.renderStatus(); }
  }
  async disconnect(): Promise<void> { this.unlocked(); this.auth.disconnect(); this.settings.autoSync = false; await this.saveSettings(); }
  async openRecovery(): Promise<void> {
    const target = path.join(this.basePath, RECOVERY, 'recovery');
    const error = await electron().shell.openPath(target);
    if (error) new Notice('Er zijn nog geen herstelkopieën of de herstelmap kon niet worden geopend.');
  }
  showLog(): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText('Drive Vault Sync — activiteit');
    modal.contentEl.createEl('p', { text: this.blocked || this.lastError || 'Geen openstaande fout.' });
    modal.contentEl.createEl('pre', { text: this.logLines.join('\n') || 'Nog geen activiteit.', cls: 'drive-vault-sync-log' });
    modal.open();
  }
  showSyncProgress(): void {
    if (this.progressPopup?.active) this.progressPopup.show();
    else new Notice('Er loopt geen synchronisatie.');
  }
  private updateSyncProgress(progress: SyncProgress): void {
    if (this.disposed || this.controller?.signal.aborted) return;
    const changedPhase = this.syncProgress?.phase !== progress.phase;
    this.syncProgress = progress;
    this.progressPopup?.update(progress);
    const now = Date.now();
    if (changedPhase || now - this.progressPaint >= 120 || progress.total === progress.completed) {
      this.closeProgressPanel?.update(progress); this.renderStatus(); this.progressPaint = now;
    }
  }
  private showPreview(report: Report): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText('Synchronisatievoorstel');
    modal.contentEl.createEl('p', { text: 'Dit voorstel heeft geen vaultbestanden gewijzigd. Een echte sync maakt altijd een nieuwe vergelijking.' });
    const counts = new Map<string, number>();
    for (const action of report.plan.actions) counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
    modal.contentEl.createEl('p', { text: [...counts].map(([kind, count]) => `${label(kind)}: ${count}`).join(' · ') || 'Geen bestanden.' });
    const list = modal.contentEl.createEl('ul');
    for (const action of report.plan.actions.filter(a => a.kind !== 'adopt' && a.kind !== 'forget').slice(0, 300)) list.createEl('li', { text: `${label(action.kind)} — ${action.path}` });
    if (report.plan.actions.length > 300) modal.contentEl.createEl('p', { text: 'Maximaal 300 bestandsacties getoond.' });
    new Setting(modal.contentEl).addButton(button => button.setButtonText('Nu synchroniseren').setCta().onClick(() => { modal.close(); void this.sync(false, true); }));
    modal.open();
  }
  sync(dryRun: boolean, manual: boolean, closingSignal?: AbortSignal): Promise<void> {
    if (this.closeSync?.holding && !closingSignal) return Promise.resolve();
    if (closingSignal?.aborted) return Promise.reject(new CancelledError('Afsluitsync gestopt.'));
    const operation = this.performSync(dryRun, manual, closingSignal);
    // performSync acquires busy synchronously; a skipped call must not replace
    // the promise of an operation that the close workflow still has to await.
    if (this.busy && !this.operation) {
      this.operation = operation;
      void operation.finally(() => { if (this.operation === operation) this.operation = undefined; }).catch(() => undefined);
    }
    return operation;
  }
  private async performSync(dryRun: boolean, manual: boolean, closingSignal?: AbortSignal): Promise<void> {
    if (this.busy || this.disposed) { if (manual && !this.disposed) { if (this.progressPopup?.active) this.showSyncProgress(); else new Notice('Er loopt al een synchronisatie of aanmelding.'); } return; }
    if (!manual && !closingSignal && (!this.settings.autoSync || Date.now() < this.nextAuto || !this.settings.rootId || this.blocked)) return;
    if (!manual && !closingSignal) { try { if (!this.auth.connected()) return; } catch { /* Report malformed credentials inside the guarded operation. */ } }
    this.busy = true; this.controller = new AbortController(); this.renderStatus();
    const abort = (): void => this.controller?.abort();
    closingSignal?.addEventListener('abort', abort, { once: true });
    let unlock: (() => void) | undefined;
    try {
      if (!closingSignal) {
        try { this.progressPopup ??= new SyncProgressPopup(() => this.stop()); this.progressPopup.start(); }
        catch (error) { this.log(`Voortgangsvenster niet beschikbaar: ${errorText(error)}`); }
      }
      this.updateSyncProgress({ phase: 'connect', completed: 0 });
      if (this.blocked) throw new SyncError(this.blocked);
      if (!this.settings.rootId) throw new SyncError('Stel eerst een Drive-map in.');
      if (closingSignal && !this.auth.connected()) throw new SyncError('Google-aanmelding ontbreekt.');
      if (typeof navigator !== 'undefined' && !navigator.onLine) throw new SyncError('Geen netwerkverbinding.');
      unlock = acquireLock(this.basePath, path.join(this.basePath, RECOVERY, 'sync.lock'));
      // Refresh under the cross-window lock, not only at plugin startup.
      this.state = this.store.load();
      if (this.state.rootId && this.state.rootId !== this.settings.rootId) throw new SyncError('Drive-map en opgeslagen syncstatus verschillen. Sla de verbinding opnieuw op.');
      this.state.rootId = this.settings.rootId;
      const signal = this.controller.signal;
      const save = async (): Promise<void> => { this.store.save(this.state); };
      const remote = new DriveClient(this.auth, this.state, save, this.app.vault.configDir, this.settings.exclude, signal);
      const account = await remote.account();
      if (this.state.accountId && this.state.accountId !== account.id) throw new SyncError('Deze baseline hoort bij een ander Google-account. Herstel de vorige aanmelding of begin de koppeling opnieuw.');
      this.state.accountId = account.id;
      await save();
      const local = new ObsidianLocal(this.app, [...this.settings.exclude]);
      const engine = new SyncEngine(local, remote, this.state, {
        deletes: this.settings.syncDeletes, configDir: this.app.vault.configDir, exclude: [...this.settings.exclude],
        save, check: () => { if (signal.aborted || this.disposed) throw new CancelledError('Synchronisatie gestopt.'); }, log: m => this.log(m), progress: progress => this.updateSyncProgress(progress)
      });
      this.log(dryRun ? 'Voorstel wordt berekend.' : 'Synchronisatie gestart: eerst downloaden.');
      const report = await engine.run(dryRun);
      if (signal.aborted || this.disposed) throw new CancelledError('Synchronisatie gestopt.');
      this.lastError = ''; this.failures = 0;
      this.nextAuto = Date.now() + this.settings.intervalSeconds * 1000;
      if (dryRun) { this.progressPopup?.finish('success', 'Voorstel klaar. Er zijn geen vaultbestanden gewijzigd.'); this.showPreview(report); }
      else {
        if (this.closeReceipt?.pending()) this.closeReceipt.write(false);
        const message = `${report.pulled} gedownload, ${report.pushed} geüpload, ${report.conflicts} conflictkopieën, ${report.deleted} naar prullenbak.`;
        this.log(message);
        if (!closingSignal) this.progressPopup?.finish('success', message);
      }
    } catch (error) {
      const message = errorText(error);
      this.log(message);
      if (!closingSignal && !this.disposed) this.progressPopup?.finish(error instanceof CancelledError ? 'cancelled' : 'error', message);
      this.failures++;
      this.nextAuto = Date.now() + Math.min(30 * 60_000, this.settings.intervalSeconds * 1000 * 2 ** Math.min(this.failures - 1, 6));
      if (!(error instanceof CancelledError)) {
        if (!closingSignal && !this.progressPopup && (manual || this.lastError !== message)) new Notice(`Drive-sync gestopt: ${message}`, 12_000);
        this.lastError = message;
      }
      // Concurrent editing deserves a fresh pull-first run soon.
      if (error instanceof ChangedError) this.nextAuto = Date.now() + 15_000;
      if (closingSignal) throw error;
    } finally { closingSignal?.removeEventListener('abort', abort); unlock?.(); this.busy = false; this.controller = undefined; this.syncProgress = undefined; this.renderStatus(); }
  }

  private installCloseSync(): void {
    const native = (window as Window & { electronWindow?: NativeWindow }).electronWindow;
    const listener = (event: NativeCloseEvent): void => this.closeSync?.nativeClose(event);
    if (native && typeof native.on === 'function' && typeof native.removeListener === 'function') {
      try {
        native.on('close', listener); this.closeBridgeAvailable = true;
        this.register(() => { try { native.removeListener('close', listener); } catch { /* window already gone */ } });
      } catch (error) { this.log(`Afsluitbrug niet beschikbaar: ${errorText(error)}`); }
    }
    this.closeSync = new CloseSync({
      enabled: () => {
        try { return !this.disposed && this.settings.autoSync && this.settings.syncOnClose && !!this.settings.rootId && this.auth.connected(); }
        catch { return false; }
      },
      timeoutMs: () => this.settings.closeTimeoutSeconds * 1000,
      start: () => {
        this.closeReceipt!.write(true, 'Afsluitsync gestart, nog niet bevestigd.');
        if (this.debounce) { clearTimeout(this.debounce); this.debounce = undefined; }
        this.progressPopup?.dispose(); this.showCloseProgress(); this.renderStatus(); this.log('Laatste synchronisatie vóór afsluiten.');
      },
      work: async signal => {
        // Stop/settle the previous run before saving the latest editor bytes.
        // Then do a fresh pull-first comparison, bypassing the normal cooldown.
        this.stop();
        await this.operation?.catch(() => undefined);
        if (signal.aborted || this.disposed) throw new CancelledError('Afsluitsync gestopt.');
        this.updateSyncProgress({ phase: 'save-editors', completed: 0 });
        await saveOpenEditors(this.app, signal, progress => this.updateSyncProgress({ ...progress, phase: 'save-editors' }));
        if (this.busy) throw new SyncError('De vorige bewerking is nog niet afgerond.');
        await this.sync(false, false, signal);
      },
      cancel: () => this.stop(),
      finish: result => this.finishCloseSync(result),
      close: () => window.close()
    }, this.closeBridgeAvailable);
    this.registerEvent(this.app.workspace.on('quit', tasks => this.closeSync?.quit(tasks)));
    if (!this.closeBridgeAvailable) this.log('Afsluitsync heeft alleen een korte best-effort afsluitwachttijd (maximaal 2 seconden).');
  }
  private showCloseProgress(): void {
    this.hideCloseProgress();
    const overlay = document.body.createDiv({ cls: 'drive-vault-sync-closing' }); this.closeOverlay = overlay;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Opslaan vóór afsluiten');
    const panel = overlay.createDiv({ cls: 'drive-vault-sync-close-panel' });
    panel.createEl('h2', { text: 'Nog even synchroniseren…' });
    panel.createEl('p', { text: 'Open notities opslaan, Drive-wijzigingen ophalen en daarna je wijzigingen uploaden.' });
    this.closeProgressPanel = new SyncProgressPanel(panel);
    this.closeProgressPanel.update({ phase: 'wait', completed: 0 });
    const remaining = panel.createEl('p'); remaining.setAttribute('role', 'status');
    const deadline = Date.now() + (this.closeBridgeAvailable ? this.settings.closeTimeoutSeconds : 2) * 1000;
    const update = (): void => remaining.setText(`Obsidian sluit zodra dit klaar is. Nog maximaal ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} seconden.`);
    update(); this.closeCountdown = setInterval(update, 1000);
    const button = panel.createEl('button', { text: 'Nu sluiten zonder te wachten' });
    button.addEventListener('click', () => this.closeSync?.skip(), { once: true }); button.focus();
    panel.createEl('p', { text: 'Bij een onderbreking blijven lokale bestanden bewaard. Een volgende sync vergelijkt opnieuw.', cls: 'drive-vault-sync-close-hint' });
  }
  private hideCloseProgress(): void {
    if (this.closeCountdown) clearInterval(this.closeCountdown);
    this.closeCountdown = undefined; this.closeOverlay?.remove(); this.closeOverlay = undefined; this.closeProgressPanel = undefined;
  }
  private finishCloseSync(result: CloseResult): void {
    const message = result.kind === 'success' ? 'Afsluitsync voltooid.' : result.kind === 'timeout' ? 'Wachttijd verstreken; afsluitsync niet bevestigd.' : result.kind === 'error' ? `Afsluitsync niet afgerond: ${errorText(result.error)}` : 'Afsluitsync onderbroken.';
    try { this.closeReceipt?.write(result.kind !== 'success', message); }
    catch (error) { this.log(`Afsluitstatus kon niet worden opgeslagen: ${errorText(error)}`); }
    this.log(message); this.hideCloseProgress(); this.renderStatus();
  }
}

export function parseFolderId(value: string): string {
  const trimmed = value.trim();
  let id = trimmed;
  if (trimmed.startsWith('https://')) {
    const url = new URL(trimmed);
    if (url.hostname !== 'drive.google.com') throw new SyncError('Gebruik een Google Drive-maplink.');
    id = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/u)?.[1] ?? '';
  }
  if (!/^[a-zA-Z0-9_-]{10,256}$/u.test(id) || id === 'root') throw new SyncError('Plak de ID of link van een aparte vaultmap in Mijn Drive.');
  return id;
}
const label = (kind: string): string => ({ pull: 'Downloaden', push: 'Uploaden', conflict: 'Beide versies bewaren', 'delete-local': 'Lokaal naar prullenbak', 'delete-remote': 'Drive naar prullenbak', adopt: 'Gelijk', forget: 'Aan beide kanten verwijderd' }[kind] ?? kind);

class DriveSettings extends PluginSettingTab {
  constructor(app: App, private plugin: DriveVaultSync) { super(app, plugin); }
  display(): void {
    const { containerEl: el } = this, plugin = this.plugin;
    el.empty(); el.createEl('h2', { text: 'Drive Vault Sync' });
    el.createEl('p', { text: 'Tweerichtingssync voor Obsidian Desktop. Drive-wijzigingen worden eerst gedownload. Bij een conflict krijgt jouw lokale versie een aparte bestandsnaam.' });
    if (plugin.blocked) el.createEl('p', { text: plugin.blocked, cls: 'drive-vault-sync-error' });
    let clientSecretStored = false, connected = false;
    try { clientSecretStored = !!plugin.auth.stored().clientSecret; connected = plugin.auth.connected(); }
    catch { el.createEl('p', { text: 'De opgeslagen aanmelding is beschadigd. Klik Afmelden en vul daarna de client secret opnieuw in.', cls: 'drive-vault-sync-error' }); }
    const action = (fn: () => Promise<unknown>): void => { void fn().then(() => this.display()).catch(error => new Notice(errorText(error), 12_000)); };
    let client = plugin.settings.clientId, folder = plugin.settings.rootId;
    new Setting(el).setName('Desktop OAuth-client-ID').setDesc('Maak een eigen Desktop app-client in Google Cloud; zie LEESMIJ.md voor de volledige installatie.').addText(text => text.setPlaceholder('…apps.googleusercontent.com').setValue(client).onChange(value => { client = value; }));
    new Setting(el).setName('Drive-vaultmap').setDesc('Een aparte map in Mijn Drive. Plak de maplink of ID. De inhoud vormt de hoofdmap van je vault.').addText(text => text.setValue(folder).onChange(value => { folder = value; }));
    new Setting(el).setName('Verbinding opslaan').setDesc('Een nieuwe map zet automatische sync en verwijderingen uit. Bekijk daarna eerst het voorstel.').addButton(button => button.setButtonText('Verbinding opslaan').onClick(() => action(() => plugin.configure(client, folder))));
    new Setting(el).setName('OAuth-client secret').setDesc('Uit de Desktop OAuth-client. Opgeslagen in Obsidian SecretStorage; komt niet in de vaultinstellingen of Drive. Bewaar eerst de client-ID.').addText(text => {
      text.inputEl.type = 'password'; text.inputEl.autocomplete = 'off';
      text.setPlaceholder(clientSecretStored ? 'Opgeslagen; leeg laten om te behouden' : 'Client secret');
      let secret = '';
      text.onChange(value => { secret = value; });
      new Setting(el).setName('Client secret bewaren').addButton(button => button.setButtonText('Bewaren').onClick(() => {
        if (plugin.busy) { new Notice('Stop eerst de lopende synchronisatie.'); return; }
        if (secret.trim()) { plugin.auth.setClientSecret(secret); text.setValue(''); secret = ''; new Notice('Client secret opgeslagen.'); }
      }));
    });
    new Setting(el).setName('Google-account').setDesc(connected ? 'Aangemeld. Tokens worden lokaal beheerd in SecretStorage.' : 'Je browser opent voor Google-toestemming.').addButton(button => button.setButtonText('Aanmelden').onClick(() => action(() => plugin.login()))).addButton(button => button.setButtonText('Afmelden').onClick(() => action(() => plugin.disconnect())));
    el.createEl('p', { text: 'Google vraagt toegang tot alle Drive-bestanden om ook bestanden te kunnen zien die je zelf in de vaultmap toevoegt. De plugin beperkt zijn bestandsacties tot de ingestelde map. Je inhoud staat als gewone bestanden in Drive; deze versie voegt geen eigen versleuteling toe.' });
    new Setting(el).setName('Automatisch synchroniseren').setDesc('Bij starten, lokale wijzigingen, focus en periodiek zolang Obsidian open is.').addToggle(toggle => toggle.setValue(plugin.settings.autoSync).onChange(value => action(() => plugin.setPaused(!value))));
    new Setting(el).setName('Interval').setDesc('Hoe vaak Drive wordt gecontroleerd; minimaal 30 seconden.').addDropdown(dropdown => dropdown.addOptions({ '30': '30 seconden', '60': '1 minuut', '120': '2 minuten', '300': '5 minuten', '600': '10 minuten', '1800': '30 minuten', '3600': '1 uur' }).setValue(String(plugin.settings.intervalSeconds)).onChange(value => { plugin.settings.intervalSeconds = Number(value); action(() => plugin.saveSettings()); }));
    new Setting(el).setName('Synchroniseren bij afsluiten').setDesc('Standaard aan. Slaat open tekstnotities op en doet een laatste sync voordat het vaultvenster sluit. Werkt wanneer automatische synchronisatie aanstaat en Google gekoppeld is; pauzeren pauzeert ook deze sync.').addToggle(toggle => toggle.setValue(plugin.settings.syncOnClose).onChange(value => { plugin.settings.syncOnClose = value; action(() => plugin.saveSettings()); }));
    new Setting(el).setName('Maximaal wachten bij afsluiten').setDesc('Sluit eerder zodra de sync klaar is. Bij een fout of het verstrijken van deze tijd wordt afgesloten; een volgende sync vergelijkt opnieuw.').addDropdown(dropdown => dropdown.addOptions({ '5': '5 seconden', '15': '15 seconden', '30': '30 seconden (standaard)', '60': '1 minuut', '120': '2 minuten' }).setValue(String(plugin.settings.closeTimeoutSeconds)).onChange(value => { plugin.settings.closeTimeoutSeconds = Number(value); action(() => plugin.saveSettings()); }));
    if (!plugin.closeBridgeAvailable) el.createEl('p', { text: 'De afsluitbrug van deze Obsidian-versie is niet beschikbaar. Automatisch wachten is daarom beperkt tot een poging van maximaal 2 seconden. Gebruik Nu synchroniseren vóór afsluiten.', cls: 'drive-vault-sync-error' });
    new Setting(el).setName('Verwijderingen doorgeven').setDesc('Standaard uit: verwijderde bestanden worden teruggehaald. Aan: uitsluitend bevestigde, ongewijzigde bestanden gaan naar de prullenbak. Maximaal 10 per ronde; grote verwijdergolven worden geblokkeerd.').addToggle(toggle => toggle.setValue(plugin.settings.syncDeletes).onChange(value => {
      if (plugin.busy) { new Notice('Stop eerst de lopende synchronisatie.'); this.display(); return; }
      plugin.settings.syncDeletes = value; action(() => plugin.saveSettings());
    }));
    let exclusions = plugin.settings.exclude.join('\n');
    new Setting(el).setName('Uitsluitingen').setDesc('Eén relatief bestand of mapprefix per regel, zonder wildcards. Verborgen mappen, configuratie, credentials en herstelkopieën zijn altijd uitgesloten. De limiet is 100 MiB per bestand.').addTextArea(text => text.setValue(exclusions).onChange(value => { exclusions = value; }));
    new Setting(el).setName('Uitsluitingen opslaan').addButton(button => button.setButtonText('Opslaan').onClick(() => action(async () => {
      if (plugin.busy) throw new SyncError('Stop eerst de lopende synchronisatie.');
      const prefixes = [...new Set(exclusions.split(/\r?\n/u).map(v => v.trim().replace(/\/$/u, '')).filter(Boolean))];
      prefixes.forEach(safePath); plugin.settings.exclude = prefixes; await plugin.saveSettings();
    })));
    new Setting(el).setName('Synchroniseren').addButton(button => button.setButtonText('Voorstel bekijken').onClick(() => action(() => plugin.sync(true, true)))).addButton(button => button.setButtonText('Nu synchroniseren').setCta().onClick(() => action(() => plugin.sync(false, true)))).addButton(button => button.setButtonText('Stoppen').onClick(() => plugin.stop()));
    new Setting(el).setName('Herstel en activiteit').addButton(button => button.setButtonText('Herstelkopieën').onClick(() => action(() => plugin.openRecovery()))).addButton(button => button.setButtonText('Activiteit').onClick(() => plugin.showLog()));
    new Setting(el).setName('Koppeling opnieuw beginnen').setDesc('Alleen de vergelijkingsgeschiedenis wordt opnieuw opgebouwd. Bij afwijkende inhoud worden beide versies bewaard. Automatische sync en verwijderen gaan uit.').addButton(button => button.setButtonText('Geschiedenis opnieuw opbouwen').onClick(() => action(() => plugin.resetBaseline())));
  }
}
