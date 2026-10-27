// Kept independent of Obsidian so both orders of Electron/renderer events can be tested.
export type CloseResult = { kind: 'success' } | { kind: 'error'; error: unknown } | { kind: 'timeout' | 'skipped' | 'disposed' };
export interface CloseOptions {
  enabled(): boolean;
  timeoutMs(): number;
  start(): void;
  work(signal: AbortSignal): Promise<void>;
  cancel(): void;
  finish(result: CloseResult): void;
  close(): void;
}
export interface NativeCloseEvent { preventDefault(): void }
export interface QuitTasks { addPromise(promise: Promise<unknown>): void }

export class CloseSync {
  private flight?: Promise<CloseResult>;
  private controller?: AbortController;
  private complete?: (result: CloseResult) => void;
  private through = false;
  private disposed = false;
  private viaQuit = false;
  private nativeAvailable: boolean;
  holding = false;

  constructor(private options: CloseOptions, nativeAvailable: boolean) { this.nativeAvailable = nativeAvailable; }
  nativeClose(event: NativeCloseEvent): void {
    const task = this.request();
    if (task) {
      // Marks Obsidian's original main-process event as cancelled too: its 3s
      // destroy timer must not race the renderer's asynchronous quit tasks.
      try { event.preventDefault(); }
      catch { this.nativeAvailable = false; this.complete?.({ kind: 'error', error: new Error('Het venster kon niet op de afsluitsync wachten.') }); }
    }
  }
  quit(tasks: QuitTasks): void {
    const task = this.request();
    if (task) { this.viaQuit = true; tasks.addPromise(task); }
  }
  request(): Promise<CloseResult> | undefined {
    if (this.disposed || this.through) return;
    if (this.flight) return this.flight;
    if (!this.options.enabled()) return;
    this.holding = true;
    this.controller = new AbortController();
    // Reserve the promise before running any application code (including callbacks).
    let settled = false;
    this.flight = new Promise<CloseResult>(resolve => {
      this.complete = result => {
        if (settled) return;
        settled = true;
        // Synchronous: skip/dispose can happen before the worker's microtask.
        if (result.kind !== 'success') this.controller?.abort();
        resolve(result);
      };
    }).then(result => {
      if (result.kind !== 'success') { this.controller?.abort(); this.options.cancel(); }
      try { this.options.finish(result); }
      finally {
        this.holding = false; this.through = true;
        // When quit was emitted, Obsidian itself closes AFTER ALL quit tasks.
        // Closing here would skip another plugin's still-pending save operation.
        if (!this.disposed && !this.viaQuit) this.options.close();
      }
      return result;
    });
    // Old/unsupported desktop bridges get only a bounded best-effort quit task.
    const limit = this.nativeAvailable ? this.options.timeoutMs() : Math.min(2000, this.options.timeoutMs());
    const timer = setTimeout(() => this.complete?.({ kind: 'timeout' }), limit);
    void this.flight.then(() => clearTimeout(timer), () => clearTimeout(timer));
    void Promise.resolve().then(async () => {
      if (this.controller!.signal.aborted) return;
      this.options.start();
      await this.options.work(this.controller!.signal);
      this.complete?.({ kind: 'success' });
    }).catch(error => this.complete?.({ kind: 'error', error }));
    return this.flight;
  }
  skip(): void { if (this.holding) this.complete?.({ kind: 'skipped' }); }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.complete?.({ kind: 'disposed' }); }
}
