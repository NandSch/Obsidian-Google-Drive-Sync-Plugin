import { App, FileSystemAdapter, MarkdownView, TextFileView, TFile, TFolder } from 'obsidian';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalPort } from './engine';
import { CancelledError, ChangedError, LocalFile, MAX_BYTES, RECOVERY, SyncError, included, md5, safePath, validateNamespace } from './model';
import { assertNoSymlinks } from './storage';
import { ScanObserver, emitProgress } from './progress';

export async function saveOpenEditors(app: App, signal: AbortSignal, progress?: ScanObserver): Promise<void> {
  const views = new Set<TextFileView>();
  app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof TextFileView && leaf.view.file) views.add(leaf.view); });
  let saved = 0;
  emitProgress(progress, { completed: saved, total: views.size });
  for (const view of views) {
    if (signal.aborted) throw new CancelledError('Opslaan gestopt.');
    emitProgress(progress, { completed: saved, total: views.size, path: view.file?.path });
    await view.save();
    emitProgress(progress, { completed: ++saved, total: views.size, path: view.file?.path });
  }
  if (signal.aborted) throw new CancelledError('Opslaan gestopt.');
}

export class ObsidianLocal implements LocalPort {
  readonly root: string;
  private session = new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID().slice(0, 8);
  constructor(private app: App, private exclude: string[]) {
    if (!(app.vault.adapter instanceof FileSystemAdapter)) throw new SyncError('Deze plugin vereist Obsidian Desktop.');
    this.root = app.vault.adapter.getBasePath();
    assertNoSymlinks(this.root, this.root);
  }
  private absolute(p: string): string {
    safePath(p);
    const target = path.join(this.root, ...p.split('/'));
    assertNoSymlinks(this.root, target);
    return target;
  }
  private checkEditor(p: string, expected: string | null): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === p) {
        const current = md5(Buffer.from(leaf.view.editor.getValue(), 'utf8'));
        if (expected !== null && current !== expected) {
          const disk = fs.readFileSync(this.absolute(p), 'utf8').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
          const editor = leaf.view.editor.getValue().replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
          if (disk !== editor) throw new ChangedError(`Onopgeslagen editorwijziging: ${p}`);
        }
      }
    }
  }
  async scan(progress?: ScanObserver): Promise<{ files: Map<string, LocalFile>; folders: Set<string> }> {
    const files = new Map<string, LocalFile>(), folders = new Set<string>();
    // getAllLoadedFiles also contains Obsidian's root TFolder (path '/').
    // It describes the vault itself, not a relative path to sync. Exclude the
    // actual root object, keeping safePath strict for every other entry.
    const rootFolder = this.app.vault.getRoot();
    const entries = this.app.vault.getAllLoadedFiles();
    const total = entries.filter(entry => entry instanceof TFile && !!entry.path && included(entry.path, this.app.vault.configDir, this.exclude)).length;
    emitProgress(progress, { completed: 0, total });
    for (const entry of entries) {
      if (entry === rootFolder) continue;
      if (!entry.path || !included(entry.path, this.app.vault.configDir, this.exclude)) continue;
      this.absolute(entry.path);
      if (entry instanceof TFolder) { folders.add(entry.path); continue; }
      if (!(entry instanceof TFile)) continue;
      if (entry.stat.size > MAX_BYTES) throw new SyncError(`Bestand groter dan 100 MiB: ${entry.path}. Sluit het uit of verplaats het.`);
      emitProgress(progress, { completed: files.size, total, path: entry.path });
      const bytes = await this.read(entry.path);
      files.set(entry.path, { hash: md5(bytes), size: bytes.length });
      emitProgress(progress, { completed: files.size, total, path: entry.path });
    }
    validateNamespace(files.keys(), folders);
    return { files, folders };
  }
  async read(p: string): Promise<Buffer> {
    const absolute = this.absolute(p);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new SyncError(`Geen regulier bestand of groter dan 100 MiB: ${p}`);
    return Buffer.from(await this.app.vault.adapter.readBinary(p));
  }
  async backup(p: string, bytes: Buffer, source: string): Promise<void> {
    safePath(p);
    const relative = `${RECOVERY}/recovery/${this.session}/${source}/${p}`;
    const target = path.join(this.root, ...relative.split('/'));
    assertNoSymlinks(this.root, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const file = target + '.' + md5(bytes).slice(0, 12) + '.bak';
    assertNoSymlinks(this.root, file);
    if (!fs.existsSync(file)) {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
  }
  private async ensureParent(p: string): Promise<void> {
    const parts = p.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      this.absolute(parent);
      const existing = this.app.vault.getAbstractFileByPath(parent);
      if (existing && !(existing instanceof TFolder)) throw new SyncError(`Bestand blokkeert map: ${parent}`);
      if (!existing) await this.app.vault.createFolder(parent);
    }
  }
  async write(p: string, bytes: Buffer, expected: string | null): Promise<void> {
    this.absolute(p); this.checkEditor(p, expected);
    await this.ensureParent(p);
    const existing = this.app.vault.getAbstractFileByPath(p);
    const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (expected === null) {
      if (existing || await this.app.vault.adapter.exists(p)) throw new ChangedError(`Bestand bestaat inmiddels: ${p}`);
      await this.app.vault.createBinary(p, array);
    } else {
      if (!(existing instanceof TFile)) throw new ChangedError(`Lokaal bestand verdwenen: ${p}`);
      const before = await this.read(p);
      if (md5(before) !== expected) throw new ChangedError(`Lokaal bestand gewijzigd: ${p}`);
      await this.backup(p, before, 'voor-download-lokaal');
      this.absolute(p); this.checkEditor(p, expected);
      const text = bytes.toString('utf8');
      if (Buffer.from(text, 'utf8').equals(bytes) && /\.(md|txt|canvas|base|json|csv|svg|html|css|js|ts|yaml|yml)$/iu.test(p)) {
        await this.app.vault.process(existing, current => {
          if (md5(Buffer.from(current, 'utf8')) !== expected) throw new ChangedError(`Lokaal bestand gewijzigd: ${p}`);
          return text;
        });
      } else {
        if (md5(await this.read(p)) !== expected) throw new ChangedError(`Lokaal bestand gewijzigd: ${p}`);
        await this.app.vault.modifyBinary(existing, array);
      }
    }
    if (md5(await this.read(p)) !== md5(bytes)) throw new ChangedError(`Controle na schrijven mislukt: ${p}`);
  }
  async remove(p: string, expected: string): Promise<void> {
    this.absolute(p); this.checkEditor(p, expected);
    const entry = this.app.vault.getAbstractFileByPath(p);
    if (!(entry instanceof TFile)) throw new ChangedError(`Lokaal bestand verdwenen: ${p}`);
    const before = await this.read(p);
    if (md5(before) !== expected) throw new ChangedError(`Lokaal gewijzigd voor verwijderen: ${p}`);
    await this.backup(p, before, 'voor-verwijderen-lokaal');
    this.absolute(p); this.checkEditor(p, expected);
    if (md5(await this.read(p)) !== expected) throw new ChangedError(`Lokaal gewijzigd voor verwijderen: ${p}`);
    // Vault trash rather than a permanent filesystem delete.
    await this.app.vault.trash(entry, false);
  }
}
