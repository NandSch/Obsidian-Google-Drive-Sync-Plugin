import { createHash } from 'node:crypto';

export const FOLDER = 'application/vnd.google-apps.folder';
export const RECOVERY = '.drive-vault-sync';
export const MAX_BYTES = 100 * 1024 * 1024;
export const SIMPLE_UPLOAD_BYTES = 5 * 1024 * 1024;
export const md5 = (data: Uint8Array): string => createHash('md5').update(data).digest('hex');

export interface LocalFile { hash: string; size: number }
export interface RemoteFile {
  id: string; name: string; parent: string; hash: string; size: number;
  etag: string; trashed: boolean; mime: string;
}
export interface Baseline { id: string; hash: string }
export interface PendingCreate { id: string; parent: string; name: string; hash: string; folder: boolean }
export interface SyncState {
  schema: 1; rootId: string; accountId: string; entries: Record<string, Baseline>;
  pending: Record<string, PendingCreate>; lastSuccess: string | null;
}
export function emptyState(rootId = '', accountId = ''): SyncState {
  return { schema: 1, rootId, accountId, entries: Object.create(null), pending: Object.create(null), lastSuccess: null };
}

export interface Settings {
  clientId: string; rootId: string; intervalSeconds: number;
  debounceSeconds: number; autoSync: boolean; syncDeletes: boolean;
  syncOnClose: boolean; closeTimeoutSeconds: number;
  exclude: string[]; secretId: string;
}
export const DEFAULT_SETTINGS: Settings = {
  clientId: '', rootId: '', intervalSeconds: 120, debounceSeconds: 8,
  autoSync: true, syncDeletes: false, syncOnClose: true, closeTimeoutSeconds: 30, exclude: [], secretId: ''
};

export class SyncError extends Error {}
export class ChangedError extends SyncError {}
export class CancelledError extends SyncError {}

// Deliberately portable: Drive permits names that Windows cannot represent.
export function validSegment(name: string): boolean {
  return !!name && name.length <= 240 && !name.startsWith('.') &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(name) && !/[. ]$/u.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) &&
    name !== '__proto__' && name !== 'constructor' && name !== 'prototype';
}
export function safePath(path: string): string {
  if (!path || path.length > 2000 || !path.split('/').every(validSegment)) {
    throw new SyncError(`Onveilige of niet-ondersteunde bestandsnaam: ${path}`);
  }
  return path;
}
export const fold = (path: string): string => path.normalize('NFC').toLocaleLowerCase('en-US');
export function included(path: string, configDir: string, exclude: string[]): boolean {
  if (path === configDir || path.startsWith(configDir + '/')) return false;
  if (path.split('/').some(p => p.startsWith('.'))) return false;
  return !exclude.some(prefix => path === prefix || path.startsWith(prefix + '/'));
}
export function validateNamespace(files: Iterable<string>, folders: Iterable<string> = []): void {
  const all = new Map<string, string>();
  const fileSet = new Set<string>();
  for (const [type, paths] of [['map', folders], ['bestand', files]] as const) {
    for (const p of paths) {
      safePath(p);
      const key = fold(p), existing = all.get(key);
      if (existing !== undefined && existing !== p) throw new SyncError(`Naamconflict: ${existing} / ${p}`);
      if (existing !== undefined && type === 'bestand') throw new SyncError(`Bestand en map hebben dezelfde naam: ${p}`);
      all.set(key, p);
      if (type === 'bestand') fileSet.add(key);
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/'), parentKey = fold(parent);
        const prior = all.get(parentKey);
        if (prior !== undefined && prior !== parent) throw new SyncError(`Naamconflict: ${prior} / ${parent}`);
        all.set(parentKey, parent);
      }
    }
  }
  for (const p of all.values()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (fileSet.has(fold(parts.slice(0, i).join('/')))) throw new SyncError(`Bestand blokkeert een map: ${p}`);
    }
  }
}

export type Kind = 'pull' | 'push' | 'conflict' | 'delete-local' | 'delete-remote' | 'adopt' | 'forget';
export interface Action { path: string; kind: Kind; local?: LocalFile; remote?: RemoteFile }
export interface Plan { actions: Action[]; deletions: number; conflicts: number }
export function planSync(local: Map<string, LocalFile>, remote: Map<string, RemoteFile>, base: Record<string, Baseline>, deletes: boolean): Plan {
  const actions: Action[] = [];
  for (const path of [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)])].sort()) {
    const l = local.get(path), r = remote.get(path), b = base[path];
    let kind: Kind;
    if (l && r) {
      if (l.hash === r.hash) kind = 'adopt';
      else if (!b) kind = 'conflict';
      else if (l.hash === b.hash) kind = 'pull';
      else if (r.hash === b.hash) kind = 'push';
      else kind = 'conflict';
    } else if (r) {
      kind = b && r.hash === b.hash && deletes ? 'delete-remote' : 'pull';
    } else if (l) {
      kind = b && l.hash === b.hash && deletes ? 'delete-local' : 'push';
    } else kind = 'forget';
    actions.push({ path, kind, local: l, remote: r });
  }
  return { actions, deletions: actions.filter(a => a.kind.startsWith('delete-')).length, conflicts: actions.filter(a => a.kind === 'conflict').length };
}

export function assertDeletionBudget(plan: Plan, baselineCount: number): void {
  // Automatic deletion is intentionally limited. A large rename is caught too.
  if (plan.deletions > 10 || (baselineCount >= 10 && plan.deletions / baselineCount > 0.2)) {
    throw new SyncError(`Massaverwijdering geblokkeerd (${plan.deletions} bestanden). Zet verwijderen uit om bestanden te herstellen, of verdeel de wijziging in kleinere stappen.`);
  }
}
export function conflictName(path: string, hash: string): string {
  const slash = path.lastIndexOf('/'), dot = path.lastIndexOf('.');
  const at = dot > slash ? dot : path.length;
  return `${path.slice(0, at)} (conflict lokaal ${hash.slice(0, 12)})${path.slice(at)}`;
}
