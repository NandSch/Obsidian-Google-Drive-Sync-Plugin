import { Action, Baseline, ChangedError, LocalFile, Plan, RemoteFile, SyncError, SyncState, assertDeletionBudget, conflictName, included, md5, planSync, validateNamespace } from './model';
import { ProgressObserver, ScanObserver, SyncPhase, emitProgress } from './progress';

export interface LocalPort {
  scan(progress?: ScanObserver): Promise<{ files: Map<string, LocalFile>; folders: Set<string> }>;
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer, expected: string | null): Promise<void>;
  remove(path: string, expected: string): Promise<void>;
  backup(path: string, data: Buffer, source: string): Promise<void>;
}
export interface RemotePort {
  scan(root: string, progress?: ScanObserver): Promise<{ files: Map<string, RemoteFile>; folders: Set<string> }>;
  inspect(id: string): Promise<RemoteFile | null>;
  read(file: RemoteFile): Promise<Buffer>;
  write(path: string, data: Buffer, expected?: RemoteFile): Promise<RemoteFile>;
  trash(file: RemoteFile): Promise<void>;
  recoverPending(): Promise<void>;
}
export interface EngineOptions {
  deletes: boolean; configDir: string; exclude: string[];
  check(): void; save(): Promise<void>; log(message: string): void;
  progress?: ProgressObserver;
}
export interface Report { pulled: number; pushed: number; conflicts: number; deleted: number; plan: Plan }

export class SyncEngine {
  constructor(private local: LocalPort, private remote: RemotePort, private state: SyncState, private options: EngineOptions) {}
  private progress(phase: SyncPhase, completed = 0, total?: number, path?: string): void { emitProgress(this.options.progress, { phase, completed, total, path }); }
  private scanProgress(phase: SyncPhase): ScanObserver { return value => emitProgress(this.options.progress, { ...value, phase }); }

  async prepare(): Promise<Plan> {
    this.options.check();
    // An interrupted create must be reconciled before a new scan/plan.
    this.progress('recover');
    await this.remote.recoverPending();
    this.progress('scan-drive');
    const remote = await this.remote.scan(this.state.rootId, this.scanProgress('scan-drive'));
    this.options.check();
    this.progress('scan-local');
    const local = await this.local.scan(this.scanProgress('scan-local'));
    this.progress('compare');
    const base: Record<string, Baseline> = Object.create(null);
    for (const [p, b] of Object.entries(this.state.entries)) {
      if (included(p, this.options.configDir, this.options.exclude)) base[p] = b;
    }
    const ids = new Set([...remote.files.values()].map(f => f.id));
    for (const [p, b] of Object.entries(base)) {
      if (remote.files.has(p) || ids.has(b.id)) continue;
      const old = await this.remote.inspect(b.id);
      if (!old || !old.trashed) {
        throw new SyncError(`Drive-bestand ontbreekt zonder bevestigde prullenbakstatus: ${p}. Mogelijk zijn rechten of de maplocatie gewijzigd. Herstel het bestand of begin de koppeling opnieuw.`);
      }
    }
    // A file on one side cannot silently overwrite a folder on the other.
    const paths = new Set([...local.files.keys(), ...remote.files.keys()]);
    const folders = new Set([...local.folders, ...remote.folders]);
    validateNamespace(paths, folders);
    const plan = planSync(local.files, remote.files, base, this.options.deletes);
    return plan;
  }

  async run(dryRun = false): Promise<Report> {
    const plan = await this.prepare();
    const report: Report = { pulled: 0, pushed: 0, conflicts: 0, deleted: 0, plan };
    if (dryRun) return report;
    const activeBaseCount = Object.keys(this.state.entries).filter(p => included(p, this.options.configDir, this.options.exclude)).length;
    assertDeletionBudget(plan, activeBaseCount);
    // Phase 1 must finish fully before any content upload or remote trash.
    const localActions = plan.actions.filter(a => ['pull', 'conflict', 'delete-local', 'adopt', 'forget'].includes(a.kind));
    localActions.sort((a, b) => Number(a.kind === 'delete-local') - Number(b.kind === 'delete-local'));
    const downloadTotal = localActions.filter(a => a.kind === 'pull' || a.kind === 'conflict').length;
    const localDeleteTotal = localActions.filter(a => a.kind === 'delete-local').length;
    let downloaded = 0, localDeleted = 0;
    for (const action of localActions) {
      this.options.check();
      const { path, kind, local: l, remote: r } = action;
      if ((kind === 'pull' || kind === 'conflict') && r) {
        this.progress('download', downloaded, downloadTotal, path);
        const bytes = await this.remote.read(r);
        this.options.check();
        if (kind === 'conflict' && l) {
          const original = await this.local.read(path);
          if (md5(original) !== l.hash) throw new ChangedError(`Lokaal gewijzigd tijdens sync: ${path}`);
          await this.local.backup(path, original, 'conflict-lokaal');
          const copy = conflictName(path, l.hash);
          const snapshot = await this.local.scan();
          const existing = snapshot.files.get(copy);
          if (existing && existing.hash !== l.hash) throw new SyncError(`Bestaande conflictkopie wijkt af: ${copy}`);
          this.options.check();
          if (!existing) await this.local.write(copy, original, null);
          report.conflicts++;
        }
        this.options.check();
        await this.local.write(path, bytes, l?.hash ?? null);
        this.state.entries[path] = { id: r.id, hash: r.hash };
        report.pulled++;
      } else if (kind === 'delete-local' && l) {
        this.progress('delete-local', localDeleted, localDeleteTotal, path);
        // Refresh tombstone immediately before applying a remote deletion.
        const b = this.state.entries[path];
        const tombstone = b ? await this.remote.inspect(b.id) : null;
        const moved = b && plan.actions.some(a => a.path !== path && a.remote?.id === b.id);
        if ((!tombstone || !tombstone.trashed) && !moved) throw new ChangedError(`Verwijdering niet meer bevestigd: ${path}`);
        this.options.check();
        await this.local.remove(path, l.hash);
        delete this.state.entries[path]; report.deleted++;
      } else if (kind === 'adopt' && l && r) this.state.entries[path] = { id: r.id, hash: l.hash };
      else if (kind === 'forget') delete this.state.entries[path];
      if (kind !== 'adopt' && kind !== 'forget') await this.options.save();
      if (kind === 'pull' || kind === 'conflict') this.progress('download', ++downloaded, downloadTotal, path);
      if (kind === 'delete-local') this.progress('delete-local', ++localDeleted, localDeleteTotal, path);
      if (kind !== 'adopt' && kind !== 'forget') this.options.log(`${kind}: ${path}`);
    }
    // Coalesce metadata-only adoptions; do not rewrite an entire baseline for
    // every unchanged file on every poll.
    await this.options.save();
    // Re-scan to include preserved conflict copies. Previously planned remote
    // downloads are now baselines; edits made meanwhile are handled next run.
    this.progress('rescan');
    const after = await this.local.scan(this.scanProgress('rescan'));
    const uploads = plan.actions.filter(a => a.kind === 'push');
    const plannedPaths = new Set(plan.actions.map(a => a.path));
    for (const [path, file] of after.files) {
      if (!plannedPaths.has(path)) uploads.push({ path, kind: 'push', local: file });
    }
    let uploaded = 0;
    for (const action of uploads) {
      this.options.check();
      this.progress('upload', uploaded, uploads.length, action.path);
      const bytes = await this.local.read(action.path);
      if (!action.local || md5(bytes) !== action.local.hash) throw new ChangedError(`Lokaal gewijzigd tijdens sync: ${action.path}`);
      // Keep a local copy of the remote preimage before replacing it, too.
      if (action.remote) await this.local.backup(action.path, await this.remote.read(action.remote), 'voor-upload-drive');
      this.options.check();
      const result = await this.remote.write(action.path, bytes, action.remote);
      this.state.entries[action.path] = { id: result.id, hash: md5(bytes) };
      await this.options.save(); report.pushed++;
      this.progress('upload', ++uploaded, uploads.length, action.path);
      this.options.log(`push: ${action.path}`);
    }
    const remoteDeletes = plan.actions.filter(a => a.kind === 'delete-remote');
    let remoteDeleted = 0;
    for (const action of remoteDeletes) {
      this.options.check();
      this.progress('delete-remote', remoteDeleted, remoteDeletes.length, action.path);
      // A file recreated locally during sync cancels its deletion.
      if ((await this.local.scan()).files.has(action.path)) throw new ChangedError(`Lokaal hersteld tijdens sync: ${action.path}`);
      if (!action.remote) continue;
      await this.local.backup(action.path, await this.remote.read(action.remote), 'voor-verwijderen-drive');
      this.options.check();
      await this.remote.trash(action.remote);
      delete this.state.entries[action.path];
      await this.options.save(); report.deleted++;
      this.progress('delete-remote', ++remoteDeleted, remoteDeletes.length, action.path);
      this.options.log(`delete-remote: ${action.path}`);
    }
    this.progress('finalize');
    this.state.lastSuccess = new Date().toISOString();
    await this.options.save();
    return report;
  }
}
