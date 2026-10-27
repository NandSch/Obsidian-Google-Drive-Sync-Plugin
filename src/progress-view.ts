import { Notice } from 'obsidian';
import { SyncOutcome, SyncProgress, describeProgress } from './progress';

export class SyncProgressPanel {
  readonly root: HTMLDivElement;
  private title: HTMLElement;
  private detail: HTMLElement;
  private file: HTMLElement;
  private bar: HTMLProgressElement;
  private stopButton?: HTMLButtonElement;
  private hideButton?: HTMLButtonElement;
  constructor(parent: HTMLElement | DocumentFragment, cancel?: () => void, hide?: () => void) {
    const doc = parent.ownerDocument!;
    this.root = doc.createElement('div'); this.root.className = 'drive-vault-sync-progress'; parent.appendChild(this.root);
    const heading = doc.createElement('strong'); heading.textContent = 'Drive Vault Sync'; this.root.appendChild(heading);
    this.title = doc.createElement('div'); this.title.className = 'drive-vault-sync-progress-title'; this.root.appendChild(this.title);
    this.title.setAttribute('role', 'status'); this.title.setAttribute('aria-live', 'polite');
    this.detail = doc.createElement('div'); this.detail.className = 'drive-vault-sync-progress-detail'; this.root.appendChild(this.detail);
    this.bar = doc.createElement('progress'); this.bar.max = 100; this.bar.setAttribute('aria-label', 'Voortgang van de huidige synchronisatiefase'); this.root.appendChild(this.bar);
    this.file = doc.createElement('div'); this.file.className = 'drive-vault-sync-progress-file'; this.root.appendChild(this.file);
    if (cancel || hide) {
      const buttons = doc.createElement('div'); buttons.className = 'drive-vault-sync-progress-buttons'; this.root.appendChild(buttons);
      if (cancel) {
        this.stopButton = doc.createElement('button'); this.stopButton.textContent = 'Stoppen'; buttons.appendChild(this.stopButton);
        this.stopButton.addEventListener('click', event => { event.stopPropagation(); this.stopButton!.disabled = true; this.stopButton!.textContent = 'Stoppen…'; cancel(); });
      }
      if (hide) {
        this.hideButton = doc.createElement('button'); this.hideButton.textContent = 'Verbergen'; buttons.appendChild(this.hideButton);
        this.hideButton.addEventListener('click', event => { event.stopPropagation(); hide(); });
      }
    }
  }
  update(progress: SyncProgress): void {
    const description = describeProgress(progress);
    this.title.textContent = description.title; this.detail.textContent = description.detail;
    this.file.textContent = progress.path ?? ''; this.file.setAttribute('title', progress.path ?? '');
    this.bar.hidden = false;
    if (description.percent === undefined) this.bar.removeAttribute('value');
    else this.bar.value = description.percent;
  }
  finish(outcome: SyncOutcome, summary: string): void {
    this.root.setAttribute('data-outcome', outcome);
    this.title.textContent = outcome === 'success' ? 'Klaar' : outcome === 'cancelled' ? 'Synchronisatie gestopt' : 'Synchronisatie niet afgerond';
    this.detail.textContent = summary; this.file.textContent = '';
    this.bar.hidden = outcome !== 'success';
    if (outcome === 'success') this.bar.value = 100;
    if (this.stopButton) { this.stopButton.disabled = true; this.stopButton.hidden = true; }
    if (this.hideButton) this.hideButton.textContent = 'Sluiten';
  }
}

export class SyncProgressPopup {
  private notice?: Notice;
  private panel?: SyncProgressPanel;
  private timer?: ReturnType<typeof setTimeout>;
  private progress: SyncProgress = { phase: 'connect', completed: 0 };
  private lastPaint = 0;
  private terminal?: { outcome: SyncOutcome; summary: string };
  active = false;
  constructor(private cancel: () => void) {}
  start(): void {
    this.dispose(); this.active = true; this.terminal = undefined;
    this.progress = { phase: 'connect', completed: 0 }; this.show();
  }
  show(): void {
    if (this.notice?.messageEl.isConnected) return;
    const fragment = document.createDocumentFragment();
    this.panel = new SyncProgressPanel(fragment, () => this.cancel(), () => this.hide());
    this.panel.update(this.progress);
    if (this.terminal) this.panel.finish(this.terminal.outcome, this.terminal.summary);
    this.notice = new Notice(fragment, 0);
    // Obsidian notices use a separate message palette (often black even in a
    // light theme). Scope the theme override to this notice's actual surface.
    const surface = this.notice.messageEl.closest<HTMLElement>('.notice') ?? this.notice.messageEl;
    surface.classList.add('drive-vault-sync-notice');
    this.notice.messageEl.classList.add('drive-vault-sync-notice-message');
    // Native notices also dismiss on click; controls explicitly stop bubbling.
  }
  update(progress: SyncProgress): void {
    if (!this.active) return;
    const changedPhase = this.progress.phase !== progress.phase;
    this.progress = { ...progress };
    const now = Date.now();
    if (changedPhase || now - this.lastPaint >= 120 || progress.total === progress.completed) {
      this.panel?.update(progress); this.lastPaint = now;
    }
  }
  finish(outcome: SyncOutcome, summary: string): void {
    if (!this.active) return;
    this.active = false; this.terminal = { outcome, summary }; this.panel?.finish(outcome, summary);
    this.timer = setTimeout(() => this.hide(), outcome === 'error' ? 15_000 : 5000);
  }
  hide(): void { this.notice?.hide(); this.notice = undefined; }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.hide(); this.panel = undefined; this.active = false; }
}
