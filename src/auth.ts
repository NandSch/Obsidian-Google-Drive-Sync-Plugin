import { createServer, Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CancelledError, SyncError } from './model';
import { Transport, http, json } from './http';

export interface Secrets { getSecret(id: string): string | null; setSecret(id: string, value: string): void }
interface Tokens { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; scope?: string }
export interface StoredCredentials { clientSecret: string; refreshToken: string }
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const challenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
export const stateMatches = (expected: string, actual: string | null): boolean => !!actual && Buffer.byteLength(expected) === Buffer.byteLength(actual) && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));

export class GoogleAuth {
  private accessToken = '';
  private expiresAt = 0;
  private refreshing?: Promise<string>;
  private server?: Server;
  private cancelLogin?: () => void;
  private loginController?: AbortController;
  constructor(readonly clientId: string, private secretId: string, private secrets: Secrets, private transport: Transport = http) {}
  stored(): StoredCredentials {
    const raw = this.secrets.getSecret(this.secretId);
    if (!raw) return { clientSecret: '', refreshToken: '' };
    try {
      const value = JSON.parse(raw) as Partial<StoredCredentials>;
      if (typeof value.clientSecret !== 'string' || typeof value.refreshToken !== 'string') throw new Error();
      return value as StoredCredentials;
    } catch { throw new SyncError('De opgeslagen Google-aanmelding is ongeldig. Meld opnieuw aan.'); }
  }
  setClientSecret(value: string): void {
    const stored = this.stored(); stored.clientSecret = value.trim();
    this.secrets.setSecret(this.secretId, JSON.stringify(stored));
  }
  connected(): boolean { return !!this.stored().refreshToken; }
  invalidate(): void { this.accessToken = ''; this.expiresAt = 0; }
  disconnect(): void {
    this.cancel(); this.invalidate();
    let stored: StoredCredentials;
    try { stored = this.stored(); } catch { stored = { clientSecret: '', refreshToken: '' }; }
    stored.refreshToken = '';
    this.secrets.setSecret(this.secretId, JSON.stringify(stored));
  }
  cancel(): void { this.loginController?.abort(); this.cancelLogin?.(); this.server?.close(); }
  private async exchange(params: Record<string, string>, signal?: AbortSignal): Promise<Tokens> {
    const stored = this.stored();
    const body = Buffer.from(new URLSearchParams({ client_id: this.clientId, ...(stored.clientSecret ? { client_secret: stored.clientSecret } : {}), ...params }).toString());
    const result = await this.transport({ url: 'https://oauth2.googleapis.com/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(body.length) }, body, signal });
    if (signal?.aborted) throw new CancelledError('Google-aanmelding gestopt.');
    const tokens = json<Tokens>(result);
    if (result.status !== 200 || !tokens.access_token) {
      const reason = tokens.error === 'invalid_grant' ? 'De Google-aanmelding is verlopen of ingetrokken. Meld opnieuw aan. In Google Testing verlopen refresh tokens doorgaans na zeven dagen.' : `Google-aanmelding mislukt (${result.status}; ${tokens.error ?? 'onbekende fout'}). Controleer je Desktop OAuth-client.`;
      throw new SyncError(reason);
    }
    if (tokens.scope && !tokens.scope.split(' ').includes(DRIVE_SCOPE)) throw new SyncError('De vereiste Google Drive-toegang is niet verleend.');
    this.accessToken = tokens.access_token;
    this.expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000 - 60_000;
    if (tokens.refresh_token) this.secrets.setSecret(this.secretId, JSON.stringify({ ...stored, refreshToken: tokens.refresh_token }));
    return tokens;
  }
  async token(signal?: AbortSignal): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    if (this.refreshing) return this.refreshing;
    const stored = this.stored();
    if (!stored.refreshToken) throw new SyncError('Meld eerst aan bij Google in de plugininstellingen.');
    this.refreshing = this.exchange({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }, signal).then(t => t.access_token!);
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }
  async login(openBrowser: (url: string) => Promise<void>): Promise<void> {
    if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/u.test(this.clientId)) throw new SyncError('Vul een geldige Google Desktop OAuth-client-ID in.');
    if (this.server) throw new SyncError('Er staat al een Google-aanmelding open.');
    const verifier = randomBytes(48).toString('base64url'), state = randomBytes(32).toString('base64url');
    const server = createServer(); this.server = server;
    this.loginController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let redirect = '';
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new SyncError('Kan geen lokale aanmeldpoort openen.');
      redirect = `http://127.0.0.1:${address.port}/oauth2callback`;
      const code = await new Promise<string>((resolve, reject) => {
        this.cancelLogin = () => reject(new CancelledError('Google-aanmelding gestopt.'));
        timer = setTimeout(() => reject(new SyncError('Google-aanmelding verliep na drie minuten.')), 180_000);
        server.on('error', reject);
        server.on('request', (req, res) => {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
          const received = new URL(req.url ?? '/', redirect);
          if (req.method !== 'GET' || received.pathname !== '/oauth2callback') { res.writeHead(404).end('Niet gevonden.'); return; }
          if (!stateMatches(state, received.searchParams.get('state'))) { res.writeHead(400).end('Ongeldige aanmeldstatus.'); return; }
          if (received.searchParams.has('error')) { res.writeHead(400).end('Aanmelding geannuleerd. Keer terug naar Obsidian.'); reject(new SyncError('Google-aanmelding geannuleerd.')); return; }
          const value = received.searchParams.get('code');
          if (!value || value.length > 4096) { res.writeHead(400).end('Aanmeldcode ontbreekt.'); return; }
          res.writeHead(200).end('Aanmelding ontvangen. Je kunt dit venster sluiten en terugkeren naar Obsidian.');
          resolve(value);
        });
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirect, response_type: 'code', scope: DRIVE_SCOPE, state, code_challenge: challenge(verifier), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' }).toString();
        void openBrowser(auth.toString()).catch(reject);
      });
      if (this.loginController.signal.aborted) throw new CancelledError('Google-aanmelding gestopt.');
      const granted = await this.exchange({ code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }, this.loginController.signal);
      if (!granted.refresh_token) {
        this.invalidate();
        throw new SyncError('Google gaf geen nieuw refresh token terug. Trek de app-toegang in je Google-account in en meld opnieuw aan.');
      }
    } finally {
      if (timer) clearTimeout(timer);
      server.close(); server.closeAllConnections();
      this.server = undefined; this.cancelLogin = undefined; this.loginController = undefined;
    }
  }
}
