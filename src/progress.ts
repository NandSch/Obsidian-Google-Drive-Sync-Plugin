export type SyncPhase = 'wait' | 'save-editors' | 'connect' | 'recover' | 'scan-drive' | 'scan-local' | 'compare' | 'download' | 'delete-local' | 'rescan' | 'upload' | 'delete-remote' | 'finalize';
export interface ScanProgress { completed: number; total?: number; path?: string; folders?: number }
export interface SyncProgress extends ScanProgress { phase: SyncPhase }
export type ProgressObserver = (progress: SyncProgress) => void;
export type ScanObserver = (progress: ScanProgress) => void;
export type SyncOutcome = 'success' | 'error' | 'cancelled';

// Reporting is observational: a UI failure must never interrupt a file operation.
export function emitProgress<T>(observer: ((value: T) => void) | undefined, value: T): void {
  try { observer?.(value); } catch { /* Keep syncing independent of the UI. */ }
}

const titles: Record<SyncPhase, string> = {
  wait: 'Vorige synchronisatie afronden', 'save-editors': 'Open notities opslaan',
  connect: 'Google-account controleren', recover: 'Onderbroken uploads controleren',
  'scan-drive': 'Google Drive inventariseren', 'scan-local': 'Lokale bestanden controleren',
  compare: 'Wijzigingen vergelijken', download: 'Drive-wijzigingen downloaden',
  'delete-local': 'Lokaal naar prullenbak', rescan: 'Lokale bestanden opnieuw controleren',
  upload: 'Lokale wijzigingen uploaden', 'delete-remote': 'Drive-bestanden naar prullenbak',
  finalize: 'Synchronisatiestatus opslaan'
};
export function describeProgress(progress: SyncProgress): { title: string; detail: string; percent?: number } {
  const title = titles[progress.phase];
  const completed = Math.max(0, progress.completed);
  const total = progress.total;
  if (total !== undefined) {
    const done = Math.min(completed, Math.max(0, total));
    // These are counts for THIS phase, never a guessed percentage of the whole run.
    const percent = total > 0 ? Math.floor(done / total * 100) : undefined;
    return { title, detail: `${done} van ${total} bestanden${percent === undefined ? '' : ` · ${percent}% van deze fase`}`, percent };
  }
  if (progress.phase === 'scan-drive') return { title, detail: `${completed} items gelezen · ${progress.folders ?? 0} mappen gecontroleerd` };
  return { title, detail: 'Bezig…' };
}
