import { randomBytes } from 'node:crypto';
import { GoogleAuth } from './auth';
import { RemotePort } from './engine';
import { HttpRequest, HttpResponse, Transport, delay, http, json } from './http';
import { ChangedError, FOLDER, MAX_BYTES, SIMPLE_UPLOAD_BYTES, RemoteFile, SyncError, SyncState, fold, included, md5, safePath, validSegment, validateNamespace } from './model';
import { ScanObserver, emitProgress } from './progress';

interface DriveFile {
  id: string; title: string; mimeType: string; md5Checksum?: string; fileSize?: string;
  etag: string; parents?: { id: string }[]; labels?: { trashed?: boolean };
  driveId?: string; capabilities?: { canEdit?: boolean; canAddChildren?: boolean; canListChildren?: boolean };
}
const FIELDS = 'id,title,mimeType,md5Checksum,fileSize,etag,parents(id),labels(trashed),driveId,capabilities(canEdit,canAddChildren,canListChildren)';
const BASE = 'https://www.googleapis.com/drive/v2/';
const queryValue = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
const identifier = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]{1,256}$/u.test(id)) throw new SyncError('Ongeldige Google Drive-ID.');
  return encodeURIComponent(id);
};
export class DriveError extends SyncError {
  constructor(readonly status: number, readonly reason: string) { super(`Google Drive: HTTP ${status} (${reason}).`); }
}
export function validateUploadURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.googleapis.com' || url.username || url.password || (url.port && url.port !== '443') || !/^\/upload\/drive\/v2\/files(?:\/[a-zA-Z0-9_-]+)?$/u.test(url.pathname) || !url.searchParams.has('upload_id') || url.hash) throw new SyncError('Google gaf een onverwacht uploadadres terug.');
  return url.toString();
}
export function acknowledged(response: HttpResponse, total: number): number {
  if (!response.headers.range) return 0;
  const match = /^bytes=0-(\d+)$/u.exec(response.headers.range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new SyncError('Google gaf een ongeldig uploadbereik terug.');
  return offset;
}

export class DriveClient implements RemotePort {
  private folders = new Map<string, DriveFile>();
  private seenFolders = new Set<string>();
  constructor(private auth: Pick<GoogleAuth, 'token' | 'invalidate'>, private state: SyncState,
    private save: () => Promise<void>, private configDir: string, private exclude: string[],
    private signal?: AbortSignal, private transport: Transport = http,
    private wait: (ms: number, signal?: AbortSignal) => Promise<void> = delay) {}

  private url(route: string, params: Record<string, string> = {}): string {
    const url = new URL(route, BASE); url.search = new URLSearchParams(params).toString(); return url.toString();
  }
  private async request(options: HttpRequest, safeRetry = false, accepted: number[] = []): Promise<HttpResponse> {
    let retriedAuth = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.token(this.signal);
      let response: HttpResponse;
      try { response = await this.transport({ ...options, signal: this.signal, headers: { ...options.headers, Authorization: `Bearer ${token}` } }); }
      catch (error) {
        if (!safeRetry || attempt >= 4 || this.signal?.aborted) throw error;
        await this.wait(Math.min(16_000, 500 * 2 ** attempt) + Math.random() * 250, this.signal); continue;
      }
      if ((response.status >= 200 && response.status < 300) || accepted.includes(response.status)) return response;
      if (response.status === 401 && !retriedAuth) { this.auth.invalidate(); retriedAuth = true; continue; }
      let reason = 'onbekende fout';
      try { const err = json<{ error?: { errors?: { reason?: string }[] } }>(response); reason = err.error?.errors?.[0]?.reason ?? reason; } catch { /* Keep errors free of response bodies and credentials. */ }
      if (response.status === 412) throw new ChangedError('Drive-bestand is tijdens de synchronisatie gewijzigd. De volgende ronde vergelijkt opnieuw.');
      const transient = response.status === 429 || [500, 502, 503, 504].includes(response.status) || (response.status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason));
      if (!safeRetry || !transient || attempt >= 4) throw new DriveError(response.status, reason);
      const retryAfter = Number(response.headers['retry-after']);
      await this.wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30_000, retryAfter * 1000) : Math.min(16_000, 500 * 2 ** attempt) + Math.random() * 250, this.signal);
    }
  }
  private convert(file: DriveFile): RemoteFile {
    if (!file.id || !file.title || !file.mimeType || !file.etag) throw new SyncError('Onvolledige Drive-metadata; synchronisatie gestopt.');
    const size = Number(file.fileSize ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new SyncError('Ongeldige bestandsgrootte van Drive.');
    if (file.mimeType !== FOLDER && !/^[a-f0-9]{32}$/u.test(file.md5Checksum ?? '')) throw new SyncError(`Geen normaal bestand: ${file.title}. Google Docs en snelkoppelingen worden niet ondersteund.`);
    return { id: file.id, name: file.title, parent: file.parents?.[0]?.id ?? '', hash: file.md5Checksum ?? '', size, etag: file.etag, mime: file.mimeType, trashed: file.labels?.trashed === true };
  }
  private async metadata(id: string): Promise<DriveFile | null> {
    try { return json<DriveFile>(await this.request({ url: this.url(`files/${identifier(id)}`, { fields: FIELDS, supportsAllDrives: 'true' }) }, true)); }
    catch (error) { if (error instanceof DriveError && error.status === 404) return null; throw error; }
  }
  async inspect(id: string): Promise<RemoteFile | null> { const file = await this.metadata(id); return file ? this.convert(file) : null; }
  async account(): Promise<{ id: string; email: string }> {
    const result = json<{ user?: { permissionId?: string; emailAddress?: string } }>(await this.request({ url: 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)' }, true));
    if (!result.user?.permissionId) throw new SyncError('Google-account kon niet worden vastgesteld.');
    return { id: result.user.permissionId, email: result.user.emailAddress ?? '' };
  }
  private async children(parent: string, page?: (count: number) => void): Promise<DriveFile[]> {
    const files: DriveFile[] = [], pages = new Set<string>();
    let token = '';
    do {
      if (pages.has(token)) throw new SyncError('Google herhaalde een pagineringstoken.');
      pages.add(token);
      const result = json<{ items?: DriveFile[]; nextPageToken?: string; incompleteSearch?: boolean }>(await this.request({ url: this.url('files', {
        q: `'${queryValue(parent)}' in parents and trashed = false`, maxResults: '1000', fields: `items(${FIELDS}),nextPageToken,incompleteSearch`, ...(token ? { pageToken: token } : {})
      }), maxBytes: 4 * 1024 * 1024 }, true));
      if (result.incompleteSearch || !Array.isArray(result.items)) throw new SyncError('Google gaf een onvolledige bestandenlijst; er worden geen verwijderingen afgeleid.');
      files.push(...result.items); token = result.nextPageToken ?? '';
      emitProgress(page, files.length);
    } while (token);
    return files;
  }
  private async assertRoot(): Promise<DriveFile> {
    const root = await this.metadata(this.state.rootId);
    if (!root || root.labels?.trashed || root.mimeType !== FOLDER || root.driveId || root.capabilities?.canAddChildren !== true || root.capabilities?.canListChildren !== true) throw new SyncError('De gekoppelde Drive-map ontbreekt, staat in de prullenbak, is niet schrijfbaar of is een Shared Drive. Gebruik een eigen map in Mijn Drive.');
    return root;
  }
  async scan(root: string, progress?: ScanObserver): Promise<{ files: Map<string, RemoteFile>; folders: Set<string> }> {
    if (root !== this.state.rootId) throw new SyncError('Drive-map komt niet overeen met de status.');
    const rootFile = await this.assertRoot();
    this.folders = new Map([['', rootFile]]); this.seenFolders = new Set([root]);
    const files = new Map<string, RemoteFile>(), folders = new Set<string>();
    const queue: { path: string; id: string; depth: number }[] = [{ path: '', id: root, depth: 0 }];
    let items = 0;
    for (let index = 0; index < queue.length; index++) {
      const folder = queue[index]!;
      if (folder.depth > 64 || queue.length > 10_000 || files.size > 100_000) throw new SyncError('Vault overschrijdt de scanlimiet (64 niveaus, 10.000 mappen of 100.000 bestanden).');
      emitProgress(progress, { completed: items, folders: index, path: folder.path });
      const children = await this.children(folder.id, count => emitProgress(progress, { completed: items + count, folders: index, path: folder.path }));
      items += children.length;
      const names = new Set<string>();
      for (const file of children) {
        const p = folder.path ? `${folder.path}/${file.title}` : file.title;
        if (!included(p, this.configDir, this.exclude)) continue;
        if (!validSegment(file.title)) throw new SyncError(`Drive-naam werkt niet veilig op Windows: ${p}`);
        if (names.has(fold(file.title))) throw new SyncError(`Dubbele bestandsnaam in Google Drive: ${p}. Geef één bestand een andere naam.`);
        names.add(fold(file.title));
        if (file.parents?.length !== 1 || file.parents[0]?.id !== folder.id || file.driveId) throw new SyncError(`Onverwachte Drive-mapstructuur: ${p}`);
        const remote = this.convert(file);
        if (remote.trashed) throw new ChangedError(`Drive-inventaris veranderde: ${p}`);
        if (remote.mime === FOLDER) {
          if (this.seenFolders.has(file.id)) throw new SyncError(`Map heeft meerdere locaties of een cyclus: ${p}`);
          this.seenFolders.add(file.id); this.folders.set(p, file); folders.add(p);
          queue.push({ path: p, id: file.id, depth: folder.depth + 1 });
        } else {
          if (remote.mime.startsWith('application/vnd.google-apps.') || remote.size > MAX_BYTES) throw new SyncError(`Niet ondersteund Drive-bestand of groter dan 100 MiB: ${p}`);
          files.set(p, remote);
        }
      }
      emitProgress(progress, { completed: items, folders: index + 1, path: folder.path });
    }
    validateNamespace(files.keys(), folders);
    return { files, folders };
  }
  private async current(expected: RemoteFile): Promise<RemoteFile> {
    const now = await this.inspect(expected.id);
    if (!now || now.trashed || now.etag !== expected.etag || now.hash !== expected.hash || now.name !== expected.name || now.parent !== expected.parent) throw new ChangedError(`Drive-bestand gewijzigd: ${expected.name}`);
    return now;
  }
  async read(file: RemoteFile): Promise<Buffer> {
    await this.current(file);
    const result = await this.request({ url: this.url(`files/${identifier(file.id)}`, { alt: 'media' }), headers: { 'If-Match': file.etag }, maxBytes: MAX_BYTES, timeoutMs: 120_000 }, true);
    if (md5(result.body) !== file.hash || result.body.length !== file.size) throw new ChangedError(`Downloadcontrole mislukt: ${file.name}`);
    await this.current(file);
    return result.body;
  }
  private async assertAncestry(parent: string, expectedRoute?: string[]): Promise<void> {
    const visited = new Set<string>(); let id = parent;
    for (let depth = 0; depth <= 64; depth++) {
      if (visited.has(id)) break; visited.add(id);
      const folder = await this.metadata(id);
      if (!folder || folder.labels?.trashed || folder.mimeType !== FOLDER || folder.driveId || folder.capabilities?.canAddChildren !== true) break;
      if (id === this.state.rootId) {
        if (expectedRoute && depth !== expectedRoute.length) break;
        return;
      }
      if (expectedRoute && folder.title !== expectedRoute[expectedRoute.length - depth - 1]) break;
      id = folder.parents?.length === 1 ? folder.parents[0]!.id : '';
      if (!id) break;
    }
    throw new ChangedError('De Drive-mapstructuur of toegang is tijdens sync veranderd.');
  }
  async recoverPending(): Promise<void> {
    if (!Object.keys(this.state.pending).length) return;
    await this.assertRoot();
    for (const [p, entry] of Object.entries(this.state.pending)) {
      const file = await this.inspect(entry.id);
      if (!file) continue; // Keep this ID reserved: never create a duplicate after an ambiguous response.
      if (file.name !== entry.name || file.parent !== entry.parent || (file.mime === FOLDER) !== entry.folder) throw new SyncError(`Onderbroken upload heeft onverwachte metadata: ${p}`);
      if (!entry.folder) {
        // An unacknowledged resumable create may still be incomplete, or a
        // second device may already have edited it. A mismatching hash is not
        // proof that the planned content was ever committed. With no assumed
        // baseline the planner preserves both versions as a first-sync conflict.
        if (file.hash === entry.hash) this.state.entries[p] = { id: entry.id, hash: entry.hash };
        else delete this.state.entries[p];
      }
      delete this.state.pending[p]; await this.save();
    }
  }
  private async reserve(p: string, parent: string, folder: boolean, hash: string): Promise<string> {
    const pending = this.state.pending[p];
    if (pending) {
      if (pending.parent !== parent || pending.folder !== folder || pending.hash !== hash) throw new SyncError(`Onderbroken upload moet eerst worden hersteld: ${p}. Herstel de lokale versie of begin de koppeling opnieuw.`);
      return pending.id;
    }
    const result = json<{ ids?: string[] }>(await this.request({ url: this.url('files/generateIds', { maxResults: '1', space: 'drive', type: 'files' }) }, true));
    const id = result.ids?.[0]; if (!id) throw new SyncError('Google gaf geen bestands-ID terug.');
    identifier(id);
    this.state.pending[p] = { id, parent, folder, hash, name: p.split('/').at(-1)! };
    await this.save(); return id;
  }
  private async ensureParent(p: string): Promise<string> {
    let parent = this.state.rootId;
    const parts = p.split('/').slice(0, -1);
    for (let i = 0; i < parts.length; i++) {
      const folderPath = parts.slice(0, i + 1).join('/');
      const cached = this.folders.get(folderPath);
      if (cached) {
        const current = await this.metadata(cached.id);
        if (!current || current.labels?.trashed || current.title !== parts[i] || current.parents?.[0]?.id !== parent) throw new ChangedError('Drive-map is verplaatst of hernoemd.');
        parent = cached.id; continue;
      }
      await this.assertAncestry(parent);
      const matches = (await this.children(parent)).filter(f => fold(f.title) === fold(parts[i]!));
      if (matches.length > 1 || (matches.length === 1 && (matches[0]!.mimeType !== FOLDER || matches[0]!.title !== parts[i]))) throw new ChangedError(`Naamconflict in Drive: ${folderPath}`);
      if (matches.length === 1) { this.folders.set(folderPath, matches[0]!); parent = matches[0]!.id; continue; }
      const id = await this.reserve(folderPath, parent, true, '');
      const body = Buffer.from(JSON.stringify({ id, title: parts[i], mimeType: FOLDER, parents: [{ id: parent }] }));
      let created: DriveFile;
      try { created = json<DriveFile>(await this.request({ url: this.url('files', { fields: FIELDS }), method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) }, body })); }
      catch (error) { const existing = await this.metadata(id); if (!existing || existing.title !== parts[i] || existing.parents?.[0]?.id !== parent || existing.mimeType !== FOLDER || existing.labels?.trashed) throw error; created = existing; }
      if (created.id !== id || created.title !== parts[i] || created.parents?.[0]?.id !== parent || created.mimeType !== FOLDER || created.labels?.trashed) throw new ChangedError(`Mapaanmaak kon niet worden bevestigd: ${folderPath}`);
      delete this.state.pending[folderPath]; await this.save();
      this.folders.set(folderPath, created); parent = id;
    }
    await this.assertAncestry(parent, parts); return parent;
  }
  private async resumable(url: URL, metadata: object, data: Buffer, expected?: RemoteFile): Promise<RemoteFile> {
    url.searchParams.set('uploadType', 'resumable');
    const body = Buffer.from(JSON.stringify(metadata));
    const condition: Record<string, string> = expected ? { 'If-Match': expected.etag } : {};
    const initiated = await this.request({ url: url.toString(), method: expected ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': String(body.length), 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(data.length), ...condition }, body });
    const location = validateUploadURL(initiated.headers.location ?? '');
    if (expected) {
      const current = await this.inspect(expected.id);
      if (!current || current.trashed || current.hash !== expected.hash || current.name !== expected.name || current.parent !== expected.parent) throw new ChangedError('Drive-inhoud veranderde bij het starten van de upload.');
      // Some session initializations update metadata/ETag before committing
      // bytes. Carry forward that current guard only when content/path agree.
      expected = current;
      condition['If-Match'] = current.etag;
    }
    let offset = 0, stalled = 0;
    while (offset < data.length) {
      const end = Math.min(data.length, offset + 8 * 1024 * 1024);
      if (expected && end === data.length) await this.current(expected);
      let response: HttpResponse;
      try {
        response = await this.request({ url: location, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - offset), 'Content-Range': `bytes ${offset}-${end - 1}/${data.length}`, ...condition }, body: data.subarray(offset, end), timeoutMs: 120_000 }, false, [308]);
      } catch (error) {
        if (this.signal?.aborted || error instanceof ChangedError || (error instanceof DriveError && ![408, 429, 500, 502, 503, 504].includes(error.status))) throw error;
        // Ask the server which bytes it has. Never infer an offset from bytes
        // sent over a connection that broke before a response arrived.
        response = await this.request({ url: location, method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${data.length}` }, body: Buffer.alloc(0) }, true, [308]);
      }
      if (response.status !== 308) return this.convert(json<DriveFile>(response));
      const next = acknowledged(response, data.length);
      if (next > end) throw new SyncError('Google bevestigde bytes die niet verzonden zijn.');
      if (next <= offset) {
        if (++stalled > 4) throw new SyncError('De hervatbare upload maakt geen voortgang.');
        await this.wait(500 * 2 ** stalled, this.signal);
      } else stalled = 0;
      offset = next;
    }
    // A final 308 is not a committed upload. Query once for final metadata.
    const completed = await this.request({ url: location, method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${data.length}` }, body: Buffer.alloc(0) }, true, [308]);
    if (completed.status === 308) throw new SyncError('Google heeft de upload nog niet afgerond.');
    return this.convert(json<DriveFile>(completed));
  }
  async write(p: string, data: Buffer, expected?: RemoteFile): Promise<RemoteFile> {
    safePath(p);
    if (data.length > MAX_BYTES) throw new SyncError('Upload is groter dan 100 MiB.');
    const parent = await this.ensureParent(p), name = p.split('/').at(-1)!;
    const siblings = (await this.children(parent)).filter(f => fold(f.title) === fold(name));
    if (expected) {
      if (parent !== expected.parent || siblings.length !== 1 || siblings[0]?.id !== expected.id) throw new ChangedError(`Drive-pad gewijzigd: ${p}`);
      await this.current(expected);
    } else if (siblings.length) throw new ChangedError(`Drive-bestand bestaat inmiddels: ${p}`);
    const hash = md5(data), id = expected?.id ?? await this.reserve(p, parent, false, hash);
    const metadata = expected ? { title: name } : { id, title: name, mimeType: 'application/octet-stream', parents: [{ id: parent }] };
    const boundary = 'vaultsync_' + randomBytes(24).toString('hex');
    const url = new URL(`https://www.googleapis.com/upload/drive/v2/files${expected ? '/' + identifier(id) : ''}`);
    url.search = new URLSearchParams({ uploadType: 'multipart', fields: FIELDS, ...(expected ? { newRevision: 'true' } : {}) }).toString();
    let result: RemoteFile;
    try {
      if (data.length > SIMPLE_UPLOAD_BYTES) result = await this.resumable(url, metadata, data, expected);
      else {
        const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
        result = this.convert(json<DriveFile>(await this.request({ url: url.toString(), method: expected ? 'PUT' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length), ...(expected ? { 'If-Match': expected.etag } : {}) }, body, timeoutMs: 120_000 })));
      }
    } catch (error) {
      // A response may be lost after Google committed the request. Read by ID,
      // never blindly retry a create or an update.
      if (this.signal?.aborted) throw error;
      const committed = await this.inspect(id);
      if (!committed || committed.trashed || committed.hash !== hash || committed.parent !== parent || committed.name !== name) throw error;
      result = committed;
    }
    if (result.id !== id || result.hash !== hash || result.parent !== parent || result.name !== name || result.trashed) throw new ChangedError(`Uploadcontrole mislukt: ${p}`);
    await this.assertAncestry(parent, p.split('/').slice(0, -1));
    // Detect same-name creates by another device. Both IDs remain on Drive.
    const matches = (await this.children(parent)).filter(f => fold(f.title) === fold(name));
    if (matches.length !== 1 || matches[0]?.id !== id) throw new ChangedError(`Gelijktijdige aanmaak in Drive: ${p}. Beide bestanden zijn bewaard; geef één versie een andere naam.`);
    if (!expected) {
      this.state.entries[p] = { id, hash };
      delete this.state.pending[p]; await this.save();
    }
    return result;
  }
  async trash(file: RemoteFile): Promise<void> {
    await this.assertAncestry(file.parent); await this.current(file);
    const body = Buffer.from(JSON.stringify({ labels: { trashed: true } }));
    await this.request({ url: this.url(`files/${identifier(file.id)}`, { fields: FIELDS }), method: 'PATCH', headers: { 'If-Match': file.etag, 'Content-Type': 'application/json', 'Content-Length': String(body.length) }, body });
    const result = await this.inspect(file.id);
    if (!result?.trashed) throw new ChangedError(`Verwijderen niet bevestigd: ${file.name}`);
  }
}
