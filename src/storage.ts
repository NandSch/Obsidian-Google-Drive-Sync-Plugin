import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Baseline, PendingCreate, SyncError, SyncState, emptyState, safePath } from './model';

export function assertNoSymlinks(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new SyncError('Pad ligt buiten de vault.');
  let current = root;
  for (const part of ['', ...relative.split(path.sep)].filter((p, i) => p || i === 0)) {
    current = part ? path.join(current, part) : current;
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new SyncError(`Symbolische link wordt niet gesynchroniseerd: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function atomicJSON(file: string, data: unknown): void {
  const temp = file + '.' + randomUUID() + '.tmp';
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const hashOK = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{32}$/u.test(x);
const idOK = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,256}$/u.test(x);
export function parseState(raw: string): SyncState {
  const x: unknown = JSON.parse(raw);
  if (!record(x) || x.schema !== 1 || typeof x.rootId !== 'string' || typeof x.accountId !== 'string' ||
    !record(x.entries) || !record(x.pending) || (x.lastSuccess !== null && typeof x.lastSuccess !== 'string')) throw new SyncError('Ongeldige synchronisatiestatus.');
  const result = emptyState(x.rootId, x.accountId);
  for (const [p, b] of Object.entries(x.entries)) {
    safePath(p);
    if (!record(b) || !idOK(b.id) || !hashOK(b.hash)) throw new SyncError('Ongeldige baseline.');
    result.entries[p] = b as unknown as Baseline;
  }
  for (const [p, b] of Object.entries(x.pending)) {
    safePath(p);
    if (!record(b) || !idOK(b.id) || !idOK(b.parent) || typeof b.name !== 'string' ||
      !safePath(b.name) || b.name.includes('/') || typeof b.folder !== 'boolean' || (b.folder ? b.hash !== '' : !hashOK(b.hash))) throw new SyncError('Ongeldig uploadjournaal.');
    result.pending[p] = b as unknown as PendingCreate;
  }
  result.lastSuccess = x.lastSuccess;
  return result;
}
export class StateStore {
  constructor(private root: string, readonly file: string) {}
  load(): SyncState {
    assertNoSymlinks(this.root, this.file);
    if (!fs.existsSync(this.file)) {
      if (fs.existsSync(this.file + '.bak')) throw new SyncError('Hoofdbestand van syncstatus ontbreekt terwijl er een backup is. Herstel sync-state.json.bak eerst.');
      return emptyState();
    }
    try { return parseState(fs.readFileSync(this.file, 'utf8')); }
    catch { throw new SyncError('sync-state.json is beschadigd. Sync is gestopt; herstel de .bak-kopie. De plugin begint niet stilzwijgend opnieuw.'); }
  }
  save(state: SyncState): void {
    assertNoSymlinks(this.root, this.file);
    assertNoSymlinks(this.root, this.file + '.bak');
    atomicJSON(this.file, state);
  }
}

// A small vault-local receipt survives a window disappearing before a final upload.
export class CloseReceipt {
  constructor(private root: string, private file: string) {}
  pending(): boolean {
    assertNoSymlinks(this.root, this.file);
    if (!fs.existsSync(this.file)) return false;
    try { const value = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { pending?: unknown }; return value.pending !== false; }
    catch { return true; }
  }
  write(pending: boolean, reason = ''): void {
    assertNoSymlinks(this.root, this.file); assertNoSymlinks(this.root, this.file + '.bak');
    atomicJSON(this.file, { schema: 1, pending, time: new Date().toISOString(), reason });
  }
}

export function acquireLock(root: string, file: string): () => void {
  assertNoSymlinks(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const nonce = randomUUID();
  const tryAcquire = (): void => {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  try { tryAcquire(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let existing: { pid?: number };
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number }; }
    catch { throw new SyncError('Onleesbaar syncslot. Sluit alle Obsidian-processen en verwijder .drive-vault-sync/sync.lock.'); }
    if (!Number.isInteger(existing.pid) || (existing.pid ?? 0) <= 0) throw new SyncError('Ongeldig syncslot.');
    try { process.kill(existing.pid!, 0); throw new SyncError('Deze vault wordt al gesynchroniseerd door een ander venster of proces.'); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
    fs.unlinkSync(file); tryAcquire();
  }
  return () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { nonce?: string };
      if (data.nonce === nonce) fs.unlinkSync(file);
    } catch { /* Never remove a lock that we cannot identify. */ }
  };
}
