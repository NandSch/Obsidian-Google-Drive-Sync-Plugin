import * as https from 'node:https';
import { CancelledError, SyncError } from './model';

export interface HttpRequest { url: string; method?: string; headers?: Record<string, string>; body?: Buffer; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal }
export interface HttpResponse { status: number; headers: Record<string, string>; body: Buffer }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;
export const http: Transport = async options => {
  const url = new URL(options.url);
  if (url.protocol !== 'https:' || !['www.googleapis.com', 'oauth2.googleapis.com'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new SyncError('Netwerkadres is niet toegestaan.');
  if (options.signal?.aborted) throw new CancelledError('Synchronisatie gestopt.');
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: options.method ?? 'GET', headers: options.headers, signal: options.signal }, response => {
      const chunks: Buffer[] = []; let size = 0;
      const max = options.maxBytes ?? 2 * 1024 * 1024;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) { response.destroy(new SyncError('Netwerkantwoord overschrijdt de ingestelde grootte.')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
    });
    const timer = setTimeout(() => req.destroy(new SyncError('Netwerkverzoek duurde te lang.')), options.timeoutMs ?? 30_000);
    req.once('close', () => clearTimeout(timer));
    req.once('error', error => reject(options.signal?.aborted ? new CancelledError('Synchronisatie gestopt.') : error));
    if (options.body) req.write(options.body);
    req.end();
  });
};
export const json = <T>(response: HttpResponse): T => {
  try { return JSON.parse(response.body.toString('utf8')) as T; }
  catch { throw new SyncError('Google stuurde een ongeldig JSON-antwoord.'); }
};
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CancelledError('Synchronisatie gestopt.')); return; }
    const cancel = (): void => { clearTimeout(timer); reject(new CancelledError('Synchronisatie gestopt.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
