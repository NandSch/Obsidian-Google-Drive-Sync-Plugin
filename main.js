Warning: truncated output (original token count: 24236)
Total output lines: 1989

/* Drive Vault Sync 1.2.1 | MIT | Source supplied alongside this build. */
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => DriveVaultSync,
  parseFolderId: () => parseFolderId
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");
var import_node_crypto6 = require("node:crypto");
var path3 = __toESM(require("node:path"));

// src/auth.ts
var import_node_http = require("node:http");
var import_node_crypto2 = require("node:crypto");

// src/model.ts
var import_node_crypto = require("node:crypto");
var FOLDER = "application/vnd.google-apps.folder";
var RECOVERY = ".drive-vault-sync";
var MAX_BYTES = 100 * 1024 * 1024;
var SIMPLE_UPLOAD_BYTES = 5 * 1024 * 1024;
var md5 = (data) => (0, import_node_crypto.createHash)("md5").update(data).digest("hex");
function emptyState(rootId = "", accountId = "") {
  return { schema: 1, rootId, accountId, entries: /* @__PURE__ */ Object.create(null), pending: /* @__PURE__ */ Object.create(null), lastSuccess: null };
}
var DEFAULT_SETTINGS = {
  clientId: "",
  rootId: "",
  intervalSeconds: 120,
  debounceSeconds: 8,
  autoSync: true,
  syncDeletes: false,
  syncOnClose: true,
  closeTimeoutSeconds: 30,
  exclude: [],
  secretId: ""
};
var SyncError = class extends Error {
};
var ChangedError = class extends SyncError {
};
var CancelledError = class extends SyncError {
};
function validSegment(name) {
  return !!name && name.length <= 240 && !name.startsWith(".") && !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(name) && !/[. ]$/u.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) && name !== "__proto__" && name !== "constructor" && name !== "prototype";
}
function safePath(path4) {
  if (!path4 || path4.length > 2e3 || !path4.split("/").every(validSegment)) {
    throw new SyncError(`Onveilige of niet-ondersteunde bestandsnaam: ${path4}`);
  }
  return path4;
}
var fold = (path4) => path4.normalize("NFC").toLocaleLowerCase("en-US");
function included(path4, configDir, exclude) {
  if (path4 === configDir || path4.startsWith(configDir + "/")) return false;
  if (path4.split("/").some((p) => p.startsWith("."))) return false;
  return !exclude.some((prefix) => path4 === prefix || path4.startsWith(prefix + "/"));
}
function validateNamespace(files, folders = []) {
  const all = /* @__PURE__ */ new Map();
  const fileSet = /* @__PURE__ */ new Set();
  for (const [type, paths] of [["map", folders], ["bestand", files]]) {
    for (const p of paths) {
      safePath(p);
      const key = fold(p), existing = all.get(key);
      if (existing !== void 0 && existing !== p) throw new SyncError(`Naamconflict: ${existing} / ${p}`);
      if (existing !== void 0 && type === "bestand") throw new SyncError(`Bestand en map hebben dezelfde naam: ${p}`);
      all.set(key, p);
      if (type === "bestand") fileSet.add(key);
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/"), parentKey = fold(parent);
        const prior = all.get(parentKey);
        if (prior !== void 0 && prior !== parent) throw new SyncError(`Naamconflict: ${prior} / ${parent}`);
        all.set(parentKey, parent);
      }
    }
  }
  for (const p of all.values()) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (fileSet.has(fold(parts.slice(0, i).join("/")))) throw new SyncError(`Bestand blokkeert een map: ${p}`);
    }
  }
}
function planSync(local, remote, base, deletes) {
  const actions = [];
  for (const path4 of [.../* @__PURE__ */ new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)])].sort()) {
    const l = local.get(path4), r = remote.get(path4), b = base[path4];
    let kind;
    if (l && r) {
      if (l.hash === r.hash) kind = "adopt";
      else if (!b) kind = "conflict";
      else if (l.hash === b.hash) kind = "pull";
      else if (r.hash === b.hash) kind = "push";
      else kind = "conflict";
    } else if (r) {
      kind = b && r.hash === b.hash && deletes ? "delete-remote" : "pull";
    } else if (l) {
      kind = b && l.hash === b.hash && deletes ? "delete-local" : "push";
    } else kind = "forget";
    actions.push({ path: path4, kind, local: l, remote: r });
  }
  return { actions, deletions: actions.filter((a) => a.kind.startsWith("delete-")).length, conflicts: actions.filter((a) => a.kind === "conflict").length };
}
function assertDeletionBudget(plan, baselineCount) {
  if (plan.deletions > 10 || baselineCount >= 10 && plan.deletions / baselineCount > 0.2) {
    throw new SyncError(`Massaverwijdering geblokkeerd (${plan.deletions} bestanden). Zet verwijderen uit om bestanden te herstellen, of verdeel de wijziging in kleinere stappen.`);
  }
}
function conflictName(path4, hash) {
  const slash = path4.lastIndexOf("/"), dot = path4.lastIndexOf(".");
  const at = dot > slash ? dot : path4.length;
  return `${path4.slice(0, at)} (conflict lokaal ${hash.slice(0, 12)})${path4.slice(at)}`;
}

// src/http.ts
var https = __toESM(require("node:https"));
var http = async (options) => {
  const url = new URL(options.url);
  if (url.protocol !== "https:" || !["www.googleapis.com", "oauth2.googleapis.com"].includes(url.hostname) || url.username || url.password || url.port && url.port !== "443") throw new SyncError("Netwerkadres is niet toegestaan.");
  if (options.signal?.aborted) throw new CancelledError("Synchronisatie gestopt.");
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: options.method ?? "GET", headers: options.headers, signal: options.signal }, (response) => {
      const chunks = [];
      let size = 0;
      const max = options.maxBytes ?? 2 * 1024 * 1024;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > max) {
          response.destroy(new SyncError("Netwerkantwoord overschrijdt de ingestelde grootte."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const headers = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== void 0) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
    });
    const timer = setTimeout(() => req.destroy(new SyncError("Netwerkverzoek duurde te lang.")), options.timeoutMs ?? 3e4);
    req.once("close", () => clearTimeout(timer));
    req.once("error", (error) => reject(options.signal?.aborted ? new CancelledError("Synchronisatie gestopt.") : error));
    if (options.body) req.write(options.body);
    req.end();
  });
};
var json = (response) => {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new SyncError("Google stuurde een ongeldig JSON-antwoord.");
  }
};
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError("Synchronisatie gestopt."));
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      reject(new CancelledError("Synchronisatie gestopt."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

// src/auth.ts
var DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
var challenge = (verifier) => (0, import_node_crypto2.createHash)("sha256").update(verifier).digest("base64url");
var stateMatches = (expected, actual) => !!actual && Buffer.byteLength(expected) === Buffer.byteLength(actual) && (0, import_node_crypto2.timingSafeEqual)(Buffer.from(expected), Buffer.from(actual));
var GoogleAuth = class {
  constructor(clientId, secretId, secrets, transport = http) {
    this.clientId = clientId;
    this.secretId = secretId;
    this.secrets = secrets;
    this.transport = transport;
  }
  accessToken = "";
  expiresAt = 0;
  refreshing;
  server;
  cancelLogin;
  loginController;
  stored() {
    const raw = this.secrets.getSecret(this.secretId);
    if (!raw) return { clientSecret: "", refreshToken: "" };
    try {
      const value = JSON.parse(raw);
      if (typeof value.clientSecret !== "string" || typeof value.refreshToken !== "string") throw new Error();
      return value;
    } catch {
      throw new SyncError("De opgeslagen Google-aanmelding is ongeldig. Meld opnieuw aan.");
    }
  }
  setClientSecret(value) {
    const stored = this.stored();
    stored.clientSecret = value.trim();
    this.secrets.setSecret(this.secretId, JSON.stringify(stored));
  }
  connected() {
    return !!this.stored().refreshToken;
  }
  invalidate() {
    this.accessToken = "";
    this.expiresAt = 0;
  }
  disconnect() {
    this.cancel();
    this.invalidate();
    let stored;
    try {
      stored = this.stored();
    } catch {
      stored = { clientSecret: "", refreshToken: "" };
    }
    stored.refreshToken = "";
    this.secrets.setSecret(this.secretId, JSON.stringify(stored));
  }
  cancel() {
    this.loginController?.abort();
    this.cancelLogin?.();
    this.server?.close();
  }
  async exchange(params, signal) {
    const stored = this.stored();
    const body = Buffer.from(new URLSearchParams({ client_id: this.clientId, ...stored.clientSecret ? { client_secret: stored.clientSecret } : {}, ...params }).toString());
    const result = await this.transport({ url: "https://oauth2.googleapis.com/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(body.length) }, body, signal });
    if (signal?.aborted) throw new CancelledError("Google-aanmelding gestopt.");
    const tokens = json(result);
    if (result.status !== 200 || !tokens.access_token) {
      const reason = tokens.error === "invalid_grant" ? "De Google-aanmelding is verlopen of ingetrokken. Meld opnieuw aan. In Google Testing verlopen refresh tokens doorgaans na zeven dagen." : `Google-aanmelding mislukt (${result.status}; ${tokens.error ?? "onbekende fout"}). Controleer je Desktop OAuth-client.`;
      throw new SyncError(reason);
    }
    if (tokens.scope && !tokens.scope.split(" ").includes(DRIVE_SCOPE)) throw new SyncError("De vereiste Google Drive-toegang is niet verleend.");
    this.accessToken = tokens.access_token;
    this.expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1e3 - 6e4;
    if (tokens.refresh_token) this.secrets.setSecret(this.secretId, JSON.stringify({ ...stored, refreshToken: tokens.refresh_token }));
    return tokens;
  }
  async token(signal) {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    if (this.refreshing) return this.refreshing;
    const stored = this.stored();
    if (!stored.refreshToken) throw new SyncError("Meld eerst aan bij Google in de plugininstellingen.");
    this.refreshing = this.exchange({ grant_type: "refresh_token", refresh_token: stored.refreshToken }, signal).then((t) => t.access_token);
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = void 0;
    }
  }
  async login(openBrowser) {
    if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/u.test(this.clientId)) throw new SyncError("Vul een geldige Google Desktop OAuth-client-ID in.");
    if (this.server) throw new SyncError("Er staat al een Google-aanmelding open.");
    const verifier = (0, import_node_crypto2.randomBytes)(48).toString("base64url"), state = (0, import_node_crypto2.randomBytes)(32).toString("base64url");
    const server = (0, import_node_http.createServer)();
    this.server = server;
    this.loginController = new AbortController();
    let timer;
    let redirect = "";
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new SyncError("Kan geen lokale aanmeldpoort openen.");
      redirect = `http://127.0.0.1:${address.port}/oauth2callback`;
      const code = await new Promise((resolve, reject) => {
        this.cancelLogin = () => reject(new CancelledError("Google-aanmelding gestopt."));
        timer = setTimeout(() => reject(new SyncError("Google-aanmelding verliep na drie minuten.")), 18e4);
        server.on("error", reject);
        server.on("request", (req, res) => {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
          const received = new URL(req.url ?? "/", redirect);
          if (req.method !== "GET" || received.pathname !== "/oauth2callback") {
            res.writeHead(404).end("Niet gevonden.");
            return;
          }
          if (!stateMatches(state, received.searchParams.get("state"))) {
            res.writeHead(400).end("Ongeldige aanmeldstatus.");
            return;
          }
          if (received.searchParams.has("error")) {
            res.writeHead(400).end("Aanmelding geannuleerd. Keer terug naar Obsidian.");
            reject(new SyncError("Google-aanmelding geannuleerd."));
            return;
          }
          const value = received.searchParams.get("code");
          if (!value || value.length > 4096) {
            res.writeHead(400).end("Aanmeldcode ontbreekt.");
            return;
          }
          res.writeHead(200).end("Aanmelding ontvangen. Je kunt dit venster sluiten en terugkeren naar Obsidian.");
          resolve(value);
        });
        const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        auth.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirect, response_type: "code", scope: DRIVE_SCOPE, state, code_challenge: challenge(verifier), code_challenge_method: "S256", access_type: "offline", prompt: "consent" }).toString();
        void openBrowser(auth.toString()).catch(reject);
      });
      if (this.loginController.signal.aborted) throw new CancelledError("Google-aanmelding gestopt.");
      const granted = await this.exchange({ code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" }, this.loginController.signal);
      if (!granted.refresh_token) {
        this.invalidate();
        throw new SyncError("Google gaf geen nieuw refresh token terug. Trek de app-toegang in je Google-account in en meld opnieuw aan.");
      }
    } finally {
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      this.server = void 0;
      this.cancelLogin = void 0;
      this.loginController = void 0;
    }
  }
};

// src/drive.ts
var import_node_crypto3 = require("node:crypto");

// src/progress.ts
function emitProgress(observer, value) {
  try {
    observer?.(value);
  } catch {
  }
}
var titles = {
  wait: "Vorige synchronisatie afronden",
  "save-editors": "Open notities opslaan",
  connect: "Google-account controleren",
  recover: "Onderbroken uploads controleren",
  "scan-drive": "Google Drive inventariseren",
  "scan-local": "Lokale bestanden controleren",
  compare: "Wijzigingen vergelijken",
  download: "Drive-wijzigingen downloaden",
  "delete-local": "Lokaal naar prullenbak",
  rescan: "Lokale bestanden opnieuw controleren",
  upload: "Lokale wijzigingen uploaden",
  "delete-remote": "Drive-bestanden naar prullenbak",
  finalize: "Synchronisatiestatus opslaan"
};
function describeProgress(progress) {
  const title = titles[progress.phase];
  const completed = Math.max(0, progress.completed);
  const total = progress.total;
  if (total !== void 0) {
    const done = Math.min(completed, Math.max(0, total));
    const percent = total > 0 ? Math.floor(done / total * 100) : void 0;
    return { title, detail: `${done} van ${total} bestanden${percent === void 0 ? "" : ` \xB7 ${percent}% van deze fase`}`, percent };
  }
  if (progress.phase === "scan-drive") return { title, detail: `${completed} items gelezen \xB7 ${progress.folders ?? 0} mappen gecontroleerd` };
  return { title, detail: "Bezig\u2026" };
}

// src/drive.ts
var FIELDS = "id,title,mimeType,md5Checksum,fileSize,etag,parents(id),labels(trashed),driveId,capabilities(canEdit,canAddChildren,canListChildren)";
var BASE = "https://www.googleapis.com/drive/v2/";
var queryValue = (value) => value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
var identifier = (id) => {
  if (!/^[a-zA-Z0-9_-]{1,256}$/u.test(id)) throw new SyncError("Ongeldige Google Drive-ID.");
  return encodeURIComponent(id);
};
var DriveError = class extends SyncError {
  constructor(status, reason) {
    super(`Google Drive: HTTP ${status} (${reason}).`);
    this.status = status;
    this.reason = reason;
  }
};
function validateUploadURL(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.googleapis.com" || url.username || url.password || url.port && url.port !== "443" || !/^\/upload\/drive\/v2\/files(?:\/[a-zA-Z0-9_-]+)?$/u.test(url.pathname) || !url.searchParams.has("upload_id") || url.hash) throw new SyncError("Google gaf een onverwacht uploadadres terug.");
  return url.toString();
}
function acknowledged(response, total) {
  if (!response.headers.range) return 0;
  const match = /^bytes=0-(\d+)$/u.exec(response.headers.range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new SyncError("Google gaf een ongeldig uploadbereik terug.");
  return offset;
}
var DriveClient = class {
  constructor(auth, state, save, configDir, exclude, signal, transport = http, wait = delay) {
    this.auth = auth;
    this.state = state;
    this.save = save;
    this.configDir = configDir;
    this.exclude = exclude;
    this.signal = signal;
    this.transport = transport;
    this.wait = wait;
  }
  folders = /* @__PURE__ */ new Map();
  seenFolders = /* @__PURE__ */ new Set();
  url(route, params = {}) {
    const url = new URL(route, BASE);
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  }
  async request(options, safeRetry = false, accepted = []) {
    let retriedAuth = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.token(this.signal);
      let response;
      try {
        response = await this.transport({ ...options, signal: this.signal, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
      } catch (error) {
        if (!safeRetry || attempt >= 4 || this.signal?.aborted) throw error;
        await this.wait(Math.min(16e3, 500 * 2 ** attempt) + Math.random() * 250, this.signal);
        continue;
      }
      if (response.status >= 200 && response.status < 300 || accepted.includes(response.status)) return response;
      if (response.status === 401 && !retriedAuth) {
        this.auth.invalidate();
        retriedAuth = true;
        continue;
      }
      let reason = "onbekende fout";
      try {
        const err = json(response);
        reason = err.error?.errors?.[0]?.reason ?? reason;
      } catch {
      }
      if (response.status === 412) throw new ChangedError("Drive-bestand is tijdens de synchronisatie gewijzigd. De volgende ronde vergelijkt opnieuw.");
      const transient = response.status === 429 || [500, 502, 503, 504].includes(response.status) || response.status === 403 && ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason);
      if (!safeRetry || !transient || attempt >= 4) throw new DriveError(response.status, reason);
      const retryAfter = Number(response.headers["retry-after"]);
      await this.wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(3e4, retryAfter * 1e3) : Math.min(16e3, 500 * 2 ** attempt) + Math.random() * 250, this.signal);
    }
  }
  convert(file) {
    if (!file.id || !file.title || !file.mimeType || !file.etag) throw new SyncError("Onvolledige Drive-metadata; synchronisatie gestopt.");
    const size = Number(file.fileSize ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new SyncError("Ongeldige bestandsgrootte van Drive.");
    if (file.mimeType !== FOLDER && !/^[a-f0-9]{32}$/u.test(file.md5Checksum ?? "")) throw new SyncError(`Geen normaal bestand: ${file.title}. Google Docs en snelkoppelingen worden niet ondersteund.`);
    return { id: file.id, name: file.title, parent: file.parents?.[0]?.id ?? "", hash: file.md5Checksum ?? "", size, etag: file.etag, mime: file.mimeType, trashed: file.labels?.trashed === true };
  }
  async metadata(id) {
    try {
      return json(await this.request({ url: this.url(`files/${identifier(id)}`, { fields: FIELDS, supportsAllDrives: "true" }) }, true));
    } catch (error) {
      if (error instanceof DriveError && error.status === 404) return null;
      throw error;
    }
  }
  async inspect(id) {
    const file = await this.metadata(id);
    return file ? this.convert(file) : null;
  }
  async account() {
    const result = json(await this.request({ url: "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)" }, true));
    if (!result.user?.permissionId) throw new SyncError("Google-account kon niet worden vastgesteld.");
    return { id: result.user.permissionId, email: result.user.emailAddress ?? "" };
  }
  async children(parent, page) {
    const files = [], pages = /* @__PURE__ */ new Set();
    let token = "";
    do {
      if (pages.has(token)) throw new SyncError("Google herhaalde een pagineringstoken.");
      pages.add(token);
      const result = json(await this.request({ url: this.url("files", {
        q: `'${queryValue(parent)}' in parents and trashed = false`,
        maxResults: "1000",
        fields: `items(${FIELDS}),nextPageToken,incompleteSearch`,
        ...token ? { pageToken: token } : {}
      }), maxBytes: 4 * 1024 * 1024 }, true));
      if (result.incompleteSearch || !Array.isArray(result.items)) throw new SyncError("Google gaf een onvolledige bestandenlijst; er worden geen verwijderingen afgeleid.");
      files.push(...result.items);
      token = result.nextPageToken ?? "";
      emitProgress(page, files.length);
    } while (token);
    return files;
  }
  async assertRoot() {
    const root = await this.metadata(this.state.rootId);
    if (!root || root.labels?.trashed || root.mimeType !== FOLDER || root.driveId || root.capabilities?.canAddChildren !== true || root.capabilities?.canListChildren !== true) throw new SyncError("De gekoppelde Drive-map ontbreekt, staat in de prullenbak, is niet schrijfbaar of is een Shared Drive. Gebruik een eigen map in Mijn Drive.");
    return root;
  }
  async scan(root, progress) {
    if (root !== this.state.rootId) throw new SyncError("Drive-map komt niet overeen met de status.");
    const rootFile = await this.assertRoot();
    this.folders = /* @__PURE__ */ new Map([["", rootFile]]);
    this.seenFolders = /* @__PURE__ */ new Set([root]);
    const files = /* @__PURE__ */ new Map(), folders = /* @__PURE__ */ new Set();
    const queue = [{ path: "", id: root, depth: 0 }];
    let items = 0;
    for (let index = 0; index < queue.length; index++) {
      const folder = queue[index];
      if (folder.depth > 64 || queue.length > 1e4 || files.size > 1e5) throw new SyncError("Vault overschrijdt de scanlimiet (64 niveaus, 10.000 mappen of 100.000 bestanden).");
      emitProgress(progress, { completed: items, folders: index, path: folder.path });
      const children = await this.children(folder.id, (count) => emitProgress(progress, { completed: items + count, folders: index, path: folder.path }));
      items += children.length;
      const names = /* @__PURE__ */ new Set();
      for (const file of children) {
        const p = folder.path ? `${folder.path}/${file.title}` : file.title;
        if (!included(p, this.configDir, this.exclude)) continue;
        if (!validSegment(file.title)) throw new SyncError(`Drive-naam werkt niet veilig op Windows: ${p}`);
        if (names.has(fold(file.title))) throw new SyncError(`Dubbele bestandsnaam in Google Drive: ${p}. Geef \xE9\xE9n bestand een andere naam.`);
        names.add(fold(file.title));
        if (file.parents?.length !== 1 || file.parents[0]?.id !== folder.id || file.driveId) throw new SyncError(`Onverwachte Drive-mapstructuur: ${p}`);
        const remote = this.convert(file);
        if (remote.trashed) throw new ChangedError(`Drive-inventaris veranderde: ${p}`);
        if (remote.mime === FOLDER) {
          if (this.seenFolders.has(file.id)) throw new SyncError(`Map heeft meerdere locaties of een cyclus: ${p}`);
          this.seenFolders.add(file.id);
          this.folders.set(p, file);
          folders.add(p);
          queue.push({ path: p, id: file.id, depth: folder.depth + 1 });
        } else {
          if (remote.mime.startsWith("application/vnd.google-apps.") || remote.size > MAX_BYTES) throw new SyncError(`Niet ondersteund Drive-bestand of groter dan 100 MiB: ${p}`);
          files.set(p, remote);
        }
      }
      emitProgress(progress, { completed: items, folders: index + 1, path: folder.path });
    }
    validateNamespace(files.keys(), folders);
    return { files, folders };
  }
  async current(expected) {
    const now = await this.inspect(expected.id);
    if (!now || now.trashed || now.etag !== expected.etag || now.hash !== expected.hash || now.name !== expected.name || now.parent !== expected.parent) throw new ChangedError(`Drive-bestand gewijzigd: ${expected.name}`);
    return now;
  }
  async read(file) {
    await this.current(file);
    const result = await this.request({ url: this.url(`files/${identifier(file.id)}`, { alt: "media" }), headers: { "If-Match": file.etag }, maxBytes: MAX_BYTES, timeoutMs: 12e4 }, true);
    if (md5(result.body) !== file.hash || result.body.length !== file.size) throw new ChangedError(`Downloadcontrole mislukt: ${file.name}`);
    await this.current(file);
    return result.body;
  }
  async assertAncestry(parent, expectedRoute) {
    const visited = /* @__PURE__ */ new Set();
    let id = parent;
    for (let depth = 0; depth <= 64; depth++) {
      if (visited.has(id)) break;
      visited.add(id);
      const folder = await this.metadata(id);
      if (!folder || folder.labels?.trashed || folder.mimeType !== FOLDER || folder.driveId || folder.capabilities?.canAddChildren !== true) break;
      if (id === this.state.rootId) {
        if (expectedRoute && depth !== expectedRoute.length) break;
        return;
      }
      if (expectedRoute && folder.title !== expectedRoute[expectedRoute.length - depth - 1]) break;
      id = folder.parents?.length === 1 ? folder.parents[0].id : "";
      if (!id) break;
    }
    throw new ChangedError("De Drive-mapstructuur of toegang is tijdens sync veranderd.");
  }
  async recoverPending() {
    if (!Object.keys(this.state.pending).length) return;
    await this.assertRoot();
    for (const [p, entry] of Object.entries(this.state.pending)) {
      const file = await this.inspect(entry.id);
      if (!file) continue;
      if (file.name !== entry.name || file.parent !== entry.parent || file.mime === FOLDER !== entry.folder) throw new SyncError(`Onderbroken upload heeft onverwachte metadata: ${p}`);
      if (!entry.folder) {
        if (file.hash === entry.hash) this.state.entries[p] = { id: entry.id, hash: entry.hash };
        else delete this.state.entries[p];
      }
      delete this.state.pending[p];
      await this.save();
    }
  }
  async reserve(p, parent, folder, hash) {
    const pending = this.state.pending[p];
    if (pending) {
      if (pending.parent !== parent || pending.folder !== folder || pending.hash !== hash) throw new SyncError(`Onderbroken upload moet eerst worden hersteld: ${p}. Herstel de lokale versie of begin de koppeling opnieuw.`);
      return pending.id;
    }
    const result = json(await this.request({ url: this.url("files/generateIds", { maxResults: "1", space: "drive", type: "files" }) }, true));
    const id = result.ids?.[0];
    if (!id) throw new SyncError("Google gaf geen bestands-ID terug.");
    identifier(id);
    this.state.pending[p] = { id, parent, folder, hash, name: p.split("/").at(-1) };
    await this.save();
    return id;
  }
  async ensureParent(p) {
    let parent = this.state.rootId;
    const parts = p.split("/").slice(0, -1);
    for (let i = 0; i < parts.length; i++) {
      const folderPath = parts.slice(0, i + 1).join("/");
      const cached = this.folders.get(folderPath);
      if (cached) {
        const current = await this.metadata(cached.id);
        if (!current || current.labels?.trashed || current.title !== parts[i] || current.parents?.[0]?.id !== parent) throw new ChangedError("Drive-map is verplaatst of hernoemd.");
        parent = cached.id;
        continue;
      }
      await this.assertAncestry(parent);
      const matches = (await this.children(parent)).filter((f) => fold(f.title) === fold(parts[i]));
      if (matches.length > 1 || matches.length === 1 && (matches[0].mimeType !== FOLDER || matches[0].title !== parts[i])) throw new ChangedError(`Naamconflict in Drive: ${folderPath}`);
      if (matches.length === 1) {
        this.folders.set(folderPath, matches[0]);
        parent = matches[0].id;
        continue;
      }
      const id = await this.reserve(folderPath, parent, true, "");
      const body = Buffer.from(JSON.stringify({ id, title: parts[i], mimeType: FOLDER, parents: [{ id: parent }] }));
      let created;
      try {
        created = json(await this.request({ url: this.url("files", { fields: FIELDS }), method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(body.length) }, body }));
      } catch (error) {
        const existing = await this.metadata(id);
        if (!existing || existing.title !== parts[i] || existing.parents?.[0]?.id !== parent || existing.mimeType !== FOLDER || existing.labels?.trashed) throw error;
        created = existing;
      }
      if (created.id !== id || created.title !== parts[i] || created.parents?.[0]?.id !== parent || created.mimeType !== FOLDER || created.labels?.trashed) throw new ChangedError(`Mapaanmaak kon niet worden bevestigd: ${folderPath}`);
      delete this.state.pending[folderPath];
      await this.save();
      this.folders.set(folderPath, created);
      parent = id;
    }
    await this.assertAncestry(parent, parts);
    return parent;
  }
  async resumable(url, metadata, data, expected) {
    url.searchParams.set("uploadType", "resumable");
    const body = Buffer.from(JSON.stringify(metadata));
    const condition = expected ? { "If-Match": expected.etag } : {};
    const initiated = await this.request({
      url: url.toString(),
      method: expected ? "PUT" : "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "Content-Length": String(body.length), "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": String(data.length), ...condition },
      body
    });
    const location = validateUploadURL(initiated.headers.location ?? "");
    if (expected) {
      const current = await this.inspect(expected.id);
      if (!current || current.trashed || current.hash !== expected.hash || current.name !== expected.name || current.parent !== expected.parent) throw new ChangedError("Drive-inhoud veranderde bij het starten van de upload.");
      expected = current;
      condition["If-Match"] = current.etag;
    }
    let offset = 0, stalled = 0;
    while (offset < data.length) {
      const end = Math.min(data.length, offset + 8 * 1024 * 1024);
      if (expected && end === data.length) await this.current(expected);
      let response;
      try {
        response = await this.request({ url: location, method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(end - offset), "Content-Range": `bytes ${offset}-${end - 1}/${data.length}`, ...condition }, body: data.subarray(offset, end), timeoutMs: 12e4 }, false, [308]);
      } catch (error) {
        if (this.signal?.aborted || error instanceof ChangedError || error instanceof DriveError && ![408, 429, 500, 502, 503, 504].includes(error.status)) throw error;
        response = await this.request({ url: location, method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${data.length}` }, body: Buffer.alloc(0) }, true, [308]);
      }
      if (response.status !== 308) return this.convert(json(response));
      const next = acknowledged(response, data.length);
      if (next > end) throw new SyncError("Google bevestigde bytes die niet verzonden zijn.");
      if (next <= offset) {
        if (++stalled > 4) throw new SyncError("De hervatbare upload maakt geen voortgang.");
        await this.wait(500 * 2 ** stalled, this.signal);
      } else stalled = 0;
      offset = next;
    }
    const completed = await this.request({ url: location, method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${data.length}` }, body: Buffer.alloc(0) }, true, [308]);
    if (completed.status === 308) throw new SyncError("Google heeft de upload nog niet afgerond.");
    return this.convert(json(completed));
  }
  async write(p, data, expected) {
    safePath(p);
    if (data.length > MAX_BYTES) throw new SyncError("Upload is groter dan 100 MiB.");
    const parent = await this.ensureParent(p), name = p.split("/").at(-1);
    const siblings = (await this.children(parent)).filter((f) => fold(f.title) === fold(name));
    if (expected) {
      if (parent !== expected.parent || siblings.length !== 1 || siblings[0]?.id !== expected.id) throw new ChangedError(`Drive-pad gewijzigd: ${p}`);
      await this.current(expected);
    } else if (siblings.length) throw new ChangedError(`Drive-bestand bestaat inmiddels: ${p}`);
    const hash = md5(data), id = expected?.id ?? await this.reserve(p, parent, false, hash);
    const metadata = expected ? { title: name } : { id, title: name, mimeType: "application/octet-stream", parents: [{ id: parent }] };
    const boundary = "vaultsync_" + (0, import_node_crypto3.randomBytes)(24).toString("hex");
    const url = new URL(`https://www.googleapis.com/upload/drive/v2/files${expected ? "/" + identifier(id) : ""}`);
    url.search = new URLSearchParams({ uploadType: "multipart", fields: FIELDS, ...expected ? { newRevision: "true" } : {} }).toString();
    let result;
    try {
      if (data.length > SIMPLE_UPLOAD_BYTES) result = await this.resumable(url, metadata, data, expected);
      else {
        const body = Buffer.concat([Buffer.from(`--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(metadata)}\r
--${boundary}\r
Content-Type: application/octet-stream\r
\r
`), data, Buffer.from(`\r
--${boundary}--\r
`)]);
        result = this.convert(json(await this.request({ url: url.toString(), method: expected ? "PUT" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": String(body.length), ...expected ? { "If-Match": expected.etag } : {} }, body, timeoutMs: 12e4 })));
      }
    } catch (error) {
      if (this.signal?.aborted) throw error;
      const committed = await this.inspect(id);
      if (!committed || committed.trashed || committed.hash !== hash || committed.parent !== parent || committed.name !== name) throw error;
      result = committed;
    }
    if (result.id !== id || result.hash !== hash || result.parent !== parent || result.name !== name || result.trashed) throw new ChangedError(`Uploadcontrole mislukt: ${p}`);
    await this.assertAncestry(parent, p.split("/").slice(0, -1));
    const matches = (await this.children(parent)).filter((f) => fold(f.title) === fold(name));
    if (matches.length !== 1 || matches[0]?.id !== id) throw new ChangedError(`Gelijktijdige aanmaak in Drive: ${p}. Beide bestanden zijn bewaard; geef \xE9\xE9n versie een andere naam.`);
    if (!expected) {
      this.state.entries[p] = { id, hash };
      delete this.state.pending[p];
      await this.save();
    }
    return result;
  }
  async trash(file) {
    await this.assertAncestry(file.parent);
    await this.current(file);
    const body = Buffer.from(JSON.stringify({ labels: { trashed: true } }));
    await this.request({ url: this.url(`files/${identifier(file.id)}`, { fields: FIELDS }), method: "PATCH", headers: { "If-Match": file.etag, "Content-Type": "application/json", "Content-Length": String(body.length) }, body });
    const result = await this.inspect(file.id);
    if (!result?.trashed) throw new ChangedError(`Verwijderen niet bevestigd: ${file.name}`);
  }
};

// src/close.ts
var CloseSync = class {
  constructor(options, nativeAvailable) {
    this.options = options;
    this.nativeAvailable = nativeAvailable;
  }
  flight;
  controller;
  complete;
  through = false;
  disposed = false;
  viaQuit = false;
  nativeAvailable;
  holding = false;
  nativeClose(event) {
    const task = this.request();
    if (task) {
      try {
        event.preventDefault();
      } catch {
        this.nativeAvailable = false;
        this.complete?.({ kind: "error", error: new Error("Het venster kon niet op de afsluitsync wachten.") });
      }
    }
  }
  quit(tasks) {
    const task = this.request();
    if (task) {
      this.viaQuit = true;
      tasks.addPromise(task);
    }
  }
  request() {
    if (this.disposed || this.through) return;
    if (this.flight) return this.flight;
    if (!this.options.enabled()) return;
    this.holding = true;
    this.controller = new AbortController();
    let settled = false;
    this.flight = new Promise((resolve) => {
      this.complete = (result) => {
        if (settled) return;
        settled = true;
        if (result.kind !== "success") this.controller?.abort();
        resolve(result);
      };
    }).then((result) => {
      if (result.kind !== "success") {
        this.controller?.abort();
        this.options.cancel();
      }
      try {
        this.options.finish(result);
      } finally {
        this.holding = false;
        this.through = true;
        if (!this.disposed && !this.viaQuit) this.options.close();
      }
      return result;
    });
    const limit = this.nativeAvailable ? this.options.timeoutMs() : Math.min(2e3, this.options.timeoutMs());
    const timer = setTimeout(() => this.complete?.({ kind: "timeout" }), limit);
    void this.fl…4236 tokens truncated…dBinary(p));
  }
  async backup(p, bytes, source) {
    safePath(p);
    const relative2 = `${RECOVERY}/recovery/${this.session}/${source}/${p}`;
    const target = path2.join(this.root, ...relative2.split("/"));
    assertNoSymlinks(this.root, target);
    fs2.mkdirSync(path2.dirname(target), { recursive: true });
    const file = target + "." + md5(bytes).slice(0, 12) + ".bak";
    assertNoSymlinks(this.root, file);
    if (!fs2.existsSync(file)) {
      const fd = fs2.openSync(file, "wx", 384);
      try {
        fs2.writeFileSync(fd, bytes);
        fs2.fsyncSync(fd);
      } finally {
        fs2.closeSync(fd);
      }
    }
  }
  async ensureParent(p) {
    const parts = p.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      this.absolute(parent);
      const existing = this.app.vault.getAbstractFileByPath(parent);
      if (existing && !(existing instanceof import_obsidian.TFolder)) throw new SyncError(`Bestand blokkeert map: ${parent}`);
      if (!existing) await this.app.vault.createFolder(parent);
    }
  }
  async write(p, bytes, expected) {
    this.absolute(p);
    this.checkEditor(p, expected);
    await this.ensureParent(p);
    const existing = this.app.vault.getAbstractFileByPath(p);
    const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (expected === null) {
      if (existing || await this.app.vault.adapter.exists(p)) throw new ChangedError(`Bestand bestaat inmiddels: ${p}`);
      await this.app.vault.createBinary(p, array);
    } else {
      if (!(existing instanceof import_obsidian.TFile)) throw new ChangedError(`Lokaal bestand verdwenen: ${p}`);
      const before = await this.read(p);
      if (md5(before) !== expected) throw new ChangedError(`Lokaal bestand gewijzigd: ${p}`);
      await this.backup(p, before, "voor-download-lokaal");
      this.absolute(p);
      this.checkEditor(p, expected);
      const text = bytes.toString("utf8");
      if (Buffer.from(text, "utf8").equals(bytes) && /\.(md|txt|canvas|base|json|csv|svg|html|css|js|ts|yaml|yml)$/iu.test(p)) {
        await this.app.vault.process(existing, (current) => {
          if (md5(Buffer.from(current, "utf8")) !== expected) throw new ChangedError(`Lokaal bestand gewijzigd: ${p}`);
          return text;
        });
      } else {
        if (md5(await this.read(p)) !== expected) throw new ChangedError(`Lokaal bestand gewijzigd: ${p}`);
        await this.app.vault.modifyBinary(existing, array);
      }
    }
    if (md5(await this.read(p)) !== md5(bytes)) throw new ChangedError(`Controle na schrijven mislukt: ${p}`);
  }
  async remove(p, expected) {
    this.absolute(p);
    this.checkEditor(p, expected);
    const entry = this.app.vault.getAbstractFileByPath(p);
    if (!(entry instanceof import_obsidian.TFile)) throw new ChangedError(`Lokaal bestand verdwenen: ${p}`);
    const before = await this.read(p);
    if (md5(before) !== expected) throw new ChangedError(`Lokaal gewijzigd voor verwijderen: ${p}`);
    await this.backup(p, before, "voor-verwijderen-lokaal");
    this.absolute(p);
    this.checkEditor(p, expected);
    if (md5(await this.read(p)) !== expected) throw new ChangedError(`Lokaal gewijzigd voor verwijderen: ${p}`);
    await this.app.vault.trash(entry, false);
  }
};

// src/progress-view.ts
var import_obsidian2 = require("obsidian");
var SyncProgressPanel = class {
  root;
  title;
  detail;
  file;
  bar;
  stopButton;
  hideButton;
  constructor(parent, cancel, hide) {
    const doc = parent.ownerDocument;
    this.root = doc.createElement("div");
    this.root.className = "drive-vault-sync-progress";
    parent.appendChild(this.root);
    const heading = doc.createElement("strong");
    heading.textContent = "Drive Vault Sync";
    this.root.appendChild(heading);
    this.title = doc.createElement("div");
    this.title.className = "drive-vault-sync-progress-title";
    this.root.appendChild(this.title);
    this.title.setAttribute("role", "status");
    this.title.setAttribute("aria-live", "polite");
    this.detail = doc.createElement("div");
    this.detail.className = "drive-vault-sync-progress-detail";
    this.root.appendChild(this.detail);
    this.bar = doc.createElement("progress");
    this.bar.max = 100;
    this.bar.setAttribute("aria-label", "Voortgang van de huidige synchronisatiefase");
    this.root.appendChild(this.bar);
    this.file = doc.createElement("div");
    this.file.className = "drive-vault-sync-progress-file";
    this.root.appendChild(this.file);
    if (cancel || hide) {
      const buttons = doc.createElement("div");
      buttons.className = "drive-vault-sync-progress-buttons";
      this.root.appendChild(buttons);
      if (cancel) {
        this.stopButton = doc.createElement("button");
        this.stopButton.textContent = "Stoppen";
        buttons.appendChild(this.stopButton);
        this.stopButton.addEventListener("click", (event) => {
          event.stopPropagation();
          this.stopButton.disabled = true;
          this.stopButton.textContent = "Stoppen\u2026";
          cancel();
        });
      }
      if (hide) {
        this.hideButton = doc.createElement("button");
        this.hideButton.textContent = "Verbergen";
        buttons.appendChild(this.hideButton);
        this.hideButton.addEventListener("click", (event) => {
          event.stopPropagation();
          hide();
        });
      }
    }
  }
  update(progress) {
    const description = describeProgress(progress);
    this.title.textContent = description.title;
    this.detail.textContent = description.detail;
    this.file.textContent = progress.path ?? "";
    this.file.setAttribute("title", progress.path ?? "");
    this.bar.hidden = false;
    if (description.percent === void 0) this.bar.removeAttribute("value");
    else this.bar.value = description.percent;
  }
  finish(outcome, summary) {
    this.root.setAttribute("data-outcome", outcome);
    this.title.textContent = outcome === "success" ? "Klaar" : outcome === "cancelled" ? "Synchronisatie gestopt" : "Synchronisatie niet afgerond";
    this.detail.textContent = summary;
    this.file.textContent = "";
    this.bar.hidden = outcome !== "success";
    if (outcome === "success") this.bar.value = 100;
    if (this.stopButton) {
      this.stopButton.disabled = true;
      this.stopButton.hidden = true;
    }
    if (this.hideButton) this.hideButton.textContent = "Sluiten";
  }
};
var SyncProgressPopup = class {
  constructor(cancel) {
    this.cancel = cancel;
  }
  notice;
  panel;
  timer;
  progress = { phase: "connect", completed: 0 };
  lastPaint = 0;
  terminal;
  active = false;
  start() {
    this.dispose();
    this.active = true;
    this.terminal = void 0;
    this.progress = { phase: "connect", completed: 0 };
    this.show();
  }
  show() {
    if (this.notice?.messageEl.isConnected) return;
    const fragment = document.createDocumentFragment();
    this.panel = new SyncProgressPanel(fragment, () => this.cancel(), () => this.hide());
    this.panel.update(this.progress);
    if (this.terminal) this.panel.finish(this.terminal.outcome, this.terminal.summary);
    this.notice = new import_obsidian2.Notice(fragment, 0);
    const surface = this.notice.messageEl.closest(".notice") ?? this.notice.messageEl;
    surface.classList.add("drive-vault-sync-notice");
    this.notice.messageEl.classList.add("drive-vault-sync-notice-message");
  }
  update(progress) {
    if (!this.active) return;
    const changedPhase = this.progress.phase !== progress.phase;
    this.progress = { ...progress };
    const now = Date.now();
    if (changedPhase || now - this.lastPaint >= 120 || progress.total === progress.completed) {
      this.panel?.update(progress);
      this.lastPaint = now;
    }
  }
  finish(outcome, summary) {
    if (!this.active) return;
    this.active = false;
    this.terminal = { outcome, summary };
    this.panel?.finish(outcome, summary);
    this.timer = setTimeout(() => this.hide(), outcome === "error" ? 15e3 : 5e3);
  }
  hide() {
    this.notice?.hide();
    this.notice = void 0;
  }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = void 0;
    this.hide();
    this.panel = void 0;
    this.active = false;
  }
};

// src/main.ts
var electron = () => require("electron");
var errorText = (error) => error instanceof Error ? error.message : "Onbekende fout.";
var DriveVaultSync = class extends import_obsidian3.Plugin {
  settings = { ...DEFAULT_SETTINGS, exclude: [] };
  state = emptyState();
  auth;
  busy = false;
  blocked = "";
  store;
  basePath = "";
  status;
  timer;
  debounce;
  controller;
  disposed = false;
  nextAuto = 0;
  failures = 0;
  logLines = [];
  lastError = "";
  operation;
  closeSync;
  closeReceipt;
  closeOverlay;
  closeCountdown;
  progressPopup;
  closeProgressPanel;
  syncProgress;
  progressPaint = 0;
  closeBridgeAvailable = false;
  async onload() {
    if (!(this.app.vault.adapter instanceof import_obsidian3.FileSystemAdapter) || !this.app.secretStorage) throw new Error("Drive Vault Sync vereist Obsidian Desktop 1.11.4 of nieuwer.");
    this.basePath = this.app.vault.adapter.getBasePath();
    const stored = await this.loadData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      clientId: typeof stored?.clientId === "string" ? stored.clientId : "",
      rootId: typeof stored?.rootId === "string" ? stored.rootId : "",
      intervalSeconds: Math.min(3600, Math.max(30, Number(stored?.intervalSeconds) || 120)),
      debounceSeconds: Math.min(300, Math.max(3, Number(stored?.debounceSeconds) || 8)),
      autoSync: typeof stored?.autoSync === "boolean" ? stored.autoSync : true,
      syncDeletes: stored?.syncDeletes === true,
      syncOnClose: typeof stored?.syncOnClose === "boolean" ? stored.syncOnClose : true,
      closeTimeoutSeconds: Math.min(120, Math.max(5, Number(stored?.closeTimeoutSeconds) || 30)),
      exclude: Array.isArray(stored?.exclude) ? stored.exclude.filter((v) => typeof v === "string") : [],
      // Vault-local identifier is not an OAuth token.
      secretId: typeof stored?.secretId === "string" && /^[a-z0-9-]+$/u.test(stored.secretId) ? stored.secretId : "drive-vault-sync-" + (0, import_node_crypto6.randomUUID)()
    };
    await this.saveData(this.settings);
    const pluginDir = this.manifest.dir;
    if (!pluginDir) throw new Error("Pluginmap kon niet worden vastgesteld.");
    this.store = new StateStore(this.basePath, path3.join(this.basePath, pluginDir, "sync-state.json"));
    this.closeReceipt = new CloseReceipt(this.basePath, path3.join(this.basePath, pluginDir, "close-sync.json"));
    try {
      this.state = this.store.load();
    } catch (error) {
      this.blocked = errorText(error);
    }
    this.auth = new GoogleAuth(this.settings.clientId, this.settings.secretId, this.app.secretStorage);
    this.installCloseSync();
    try {
      if (this.closeReceipt.pending()) new import_obsidian3.Notice("De vorige afsluitsync is niet bevestigd. Lokale bestanden blijven bewaard; laat Drive opnieuw synchroniseren.", 15e3);
    } catch (error) {
      this.log(errorText(error));
    }
    this.status = this.addStatusBarItem();
    this.status.addClass("drive-vault-sync-status");
    this.status.setAttribute("role", "button");
    this.status.setAttribute("tabindex", "0");
    this.registerDomEvent(this.status, "click", () => void this.sync(false, true));
    this.registerDomEvent(this.status, "keydown", (event) => {
      if (event.key === "Enter") void this.sync(false, true);
    });
    this.renderStatus();
    this.addRibbonIcon("cloud-download", "Drive Vault Sync: nu synchroniseren", () => void this.sync(false, true));
    this.addCommand({ id: "sync-now", name: "Nu synchroniseren (eerst downloaden)", callback: () => void this.sync(false, true) });
    this.addCommand({ id: "preview", name: "Synchronisatie vooraf bekijken", callback: () => void this.sync(true, true) });
    this.addCommand({ id: "stop", name: "Lopende synchronisatie stoppen", callback: () => this.stop() });
    this.addCommand({ id: "pause", name: "Automatische synchronisatie pauzeren of hervatten", callback: () => void this.setPaused(this.settings.autoSync) });
    this.addCommand({ id: "log", name: "Activiteit en laatste fout bekijken", callback: () => this.showLog() });
    this.addCommand({ id: "progress", name: "Synchronisatievoortgang bekijken", callback: () => this.showSyncProgress() });
    this.addCommand({ id: "recovery", name: "Herstelkopie\xEBn openen", callback: () => void this.openRecovery() });
    this.addSettingTab(new DriveSettings(this.app, this));
    const changed = () => this.schedule();
    this.registerEvent(this.app.vault.on("create", changed));
    this.registerEvent(this.app.vault.on("modify", changed));
    this.registerEvent(this.app.vault.on("delete", changed));
    this.registerEvent(this.app.vault.on("rename", changed));
    this.registerDomEvent(window, "online", () => {
      this.nextAuto = 0;
      this.schedule();
    });
    this.registerDomEvent(window, "focus", () => this.schedule());
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) this.schedule();
    });
    this.timer = setInterval(() => {
      if (Date.now() >= this.nextAuto) void this.sync(false, false);
    }, 15e3);
    this.registerInterval(this.timer);
    this.app.workspace.onLayoutReady(() => {
      if (!this.disposed) this.schedule();
    });
  }
  onunload() {
    this.disposed = true;
    this.closeSync?.dispose();
    this.hideCloseProgress();
    this.stop();
    this.auth?.cancel();
    this.progressPopup?.dispose();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
  }
  renderStatus() {
    if (!this.status) return;
    const progress = this.syncProgress ? describeProgress(this.syncProgress) : void 0;
    const runningText = progress ? `Drive: ${progress.title}${progress.percent === void 0 ? "\u2026" : ` ${progress.percent}%`}` : "Drive: synchroniseren\u2026";
    this.status.setText(this.closeSync?.holding ? "Drive: opslaan v\xF3\xF3r afsluiten\u2026" : this.busy ? runningText : this.blocked || this.lastError ? "Drive: aandacht nodig" : this.settings.autoSync ? "Drive: gereed" : "Drive: gepauzeerd");
    this.status.setAttribute("aria-label", this.busy ? "Drive Vault Sync: voortgang bekijken" : "Drive Vault Sync: nu synchroniseren");
    this.status.setAttribute("title", this.busy && progress ? `${progress.title}: ${progress.detail}${this.syncProgress?.path ? ` \u2014 ${this.syncProgress.path}` : ""}` : this.blocked || this.lastError || (this.state.lastSuccess ? `Laatste sync: ${new Date(this.state.lastSuccess).toLocaleString()}` : "Nog geen geslaagde synchronisatie"));
  }
  log(message) {
    this.logLines.push(`${(/* @__PURE__ */ new Date()).toLocaleTimeString()} ${message}`);
    if (this.logLines.length > 200) this.logLines.shift();
  }
  schedule() {
    if (this.busy || this.disposed || this.closeSync?.holding || !this.settings.autoSync) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = void 0;
      void this.sync(false, false);
    }, this.settings.debounceSeconds * 1e3);
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.renderStatus();
  }
  async setPaused(paused) {
    this.settings.autoSync = !paused;
    if (paused) {
      this.stop();
      if (this.debounce) clearTimeout(this.debounce);
    } else {
      this.nextAuto = 0;
      this.schedule();
    }
    await this.saveSettings();
    new import_obsidian3.Notice(paused ? "Automatische Drive-sync gepauzeerd." : "Automatische Drive-sync hervat.");
  }
  stop() {
    this.controller?.abort();
    this.auth?.cancel();
  }
  unlocked() {
    if (this.busy || this.closeSync?.holding) throw new SyncError("Stop de lopende synchronisatie voordat je deze instelling wijzigt.");
  }
  stateLock() {
    this.unlocked();
    return acquireLock(this.basePath, path3.join(this.basePath, RECOVERY, "sync.lock"));
  }
  async configure(clientId, root) {
    this.unlocked();
    clientId = clientId.trim();
    const rootId = parseFolderId(root);
    if (this.blocked) throw new SyncError(this.blocked);
    const unlock = this.stateLock();
    try {
      this.state = this.store.load();
      if (this.settings.clientId !== clientId) {
        this.auth.disconnect();
        this.settings.clientId = clientId;
      }
      if (this.settings.rootId !== rootId || this.state.rootId !== rootId) {
        this.settings.rootId = rootId;
        this.state = emptyState(rootId);
        this.store.save(this.state);
        this.settings.syncDeletes = false;
        this.settings.autoSync = false;
      }
      this.auth = new GoogleAuth(this.settings.clientId, this.settings.secretId, this.app.secretStorage);
      this.lastError = "";
      this.nextAuto = 0;
      await this.saveSettings();
    } finally {
      unlock();
    }
  }
  async resetBaseline() {
    this.unlocked();
    if (this.blocked) throw new SyncError(this.blocked);
    const unlock = this.stateLock();
    try {
      this.state = emptyState(this.settings.rootId);
      this.store.save(this.state);
      this.settings.syncDeletes = false;
      this.settings.autoSync = false;
      await this.saveSettings();
    } finally {
      unlock();
    }
    new import_obsidian3.Notice("Koppeling begint opnieuw. Verwijderingen en automatische sync staan uit. Bekijk eerst het synchronisatievoorstel.");
  }
  async login() {
    this.unlocked();
    this.busy = true;
    this.renderStatus();
    const operation = this.auth.login((url) => electron().shell.openExternal(url));
    this.operation = operation;
    try {
      await operation;
      new import_obsidian3.Notice("Google-aanmelding opgeslagen. Bekijk nu het synchronisatievoorstel.");
    } finally {
      if (this.operation === operation) this.operation = void 0;
      this.busy = false;
      this.renderStatus();
    }
  }
  async disconnect() {
    this.unlocked();
    this.auth.disconnect();
    this.settings.autoSync = false;
    await this.saveSettings();
  }
  async openRecovery() {
    const target = path3.join(this.basePath, RECOVERY, "recovery");
    const error = await electron().shell.openPath(target);
    if (error) new import_obsidian3.Notice("Er zijn nog geen herstelkopie\xEBn of de herstelmap kon niet worden geopend.");
  }
  showLog() {
    const modal = new import_obsidian3.Modal(this.app);
    modal.titleEl.setText("Drive Vault Sync \u2014 activiteit");
    modal.contentEl.createEl("p", { text: this.blocked || this.lastError || "Geen openstaande fout." });
    modal.contentEl.createEl("pre", { text: this.logLines.join("\n") || "Nog geen activiteit.", cls: "drive-vault-sync-log" });
    modal.open();
  }
  showSyncProgress() {
    if (this.progressPopup?.active) this.progressPopup.show();
    else new import_obsidian3.Notice("Er loopt geen synchronisatie.");
  }
  updateSyncProgress(progress) {
    if (this.disposed || this.controller?.signal.aborted) return;
    const changedPhase = this.syncProgress?.phase !== progress.phase;
    this.syncProgress = progress;
    this.progressPopup?.update(progress);
    const now = Date.now();
    if (changedPhase || now - this.progressPaint >= 120 || progress.total === progress.completed) {
      this.closeProgressPanel?.update(progress);
      this.renderStatus();
      this.progressPaint = now;
    }
  }
  showPreview(report) {
    const modal = new import_obsidian3.Modal(this.app);
    modal.titleEl.setText("Synchronisatievoorstel");
    modal.contentEl.createEl("p", { text: "Dit voorstel heeft geen vaultbestanden gewijzigd. Een echte sync maakt altijd een nieuwe vergelijking." });
    const counts = /* @__PURE__ */ new Map();
    for (const action of report.plan.actions) counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
    modal.contentEl.createEl("p", { text: [...counts].map(([kind, count]) => `${label(kind)}: ${count}`).join(" \xB7 ") || "Geen bestanden." });
    const list = modal.contentEl.createEl("ul");
    for (const action of report.plan.actions.filter((a) => a.kind !== "adopt" && a.kind !== "forget").slice(0, 300)) list.createEl("li", { text: `${label(action.kind)} \u2014 ${action.path}` });
    if (report.plan.actions.length > 300) modal.contentEl.createEl("p", { text: "Maximaal 300 bestandsacties getoond." });
    new import_obsidian3.Setting(modal.contentEl).addButton((button) => button.setButtonText("Nu synchroniseren").setCta().onClick(() => {
      modal.close();
      void this.sync(false, true);
    }));
    modal.open();
  }
  sync(dryRun, manual, closingSignal) {
    if (this.closeSync?.holding && !closingSignal) return Promise.resolve();
    if (closingSignal?.aborted) return Promise.reject(new CancelledError("Afsluitsync gestopt."));
    const operation = this.performSync(dryRun, manual, closingSignal);
    if (this.busy && !this.operation) {
      this.operation = operation;
      void operation.finally(() => {
        if (this.operation === operation) this.operation = void 0;
      }).catch(() => void 0);
    }
    return operation;
  }
  async performSync(dryRun, manual, closingSignal) {
    if (this.busy || this.disposed) {
      if (manual && !this.disposed) {
        if (this.progressPopup?.active) this.showSyncProgress();
        else new import_obsidian3.Notice("Er loopt al een synchronisatie of aanmelding.");
      }
      return;
    }
    if (!manual && !closingSignal && (!this.settings.autoSync || Date.now() < this.nextAuto || !this.settings.rootId || this.blocked)) return;
    if (!manual && !closingSignal) {
      try {
        if (!this.auth.connected()) return;
      } catch {
      }
    }
    this.busy = true;
    this.controller = new AbortController();
    this.renderStatus();
    const abort = () => this.controller?.abort();
    closingSignal?.addEventListener("abort", abort, { once: true });
    let unlock;
    try {
      if (!closingSignal) {
        try {
          this.progressPopup ??= new SyncProgressPopup(() => this.stop());
          this.progressPopup.start();
        } catch (error) {
          this.log(`Voortgangsvenster niet beschikbaar: ${errorText(error)}`);
        }
      }
      this.updateSyncProgress({ phase: "connect", completed: 0 });
      if (this.blocked) throw new SyncError(this.blocked);
      if (!this.settings.rootId) throw new SyncError("Stel eerst een Drive-map in.");
      if (closingSignal && !this.auth.connected()) throw new SyncError("Google-aanmelding ontbreekt.");
      if (typeof navigator !== "undefined" && !navigator.onLine) throw new SyncError("Geen netwerkverbinding.");
      unlock = acquireLock(this.basePath, path3.join(this.basePath, RECOVERY, "sync.lock"));
      this.state = this.store.load();
      if (this.state.rootId && this.state.rootId !== this.settings.rootId) throw new SyncError("Drive-map en opgeslagen syncstatus verschillen. Sla de verbinding opnieuw op.");
      this.state.rootId = this.settings.rootId;
      const signal = this.controller.signal;
      const save = async () => {
        this.store.save(this.state);
      };
      const remote = new DriveClient(this.auth, this.state, save, this.app.vault.configDir, this.settings.exclude, signal);
      const account = await remote.account();
      if (this.state.accountId && this.state.accountId !== account.id) throw new SyncError("Deze baseline hoort bij een ander Google-account. Herstel de vorige aanmelding of begin de koppeling opnieuw.");
      this.state.accountId = account.id;
      await save();
      const local = new ObsidianLocal(this.app, [...this.settings.exclude]);
      const engine = new SyncEngine(local, remote, this.state, {
        deletes: this.settings.syncDeletes,
        configDir: this.app.vault.configDir,
        exclude: [...this.settings.exclude],
        save,
        check: () => {
          if (signal.aborted || this.disposed) throw new CancelledError("Synchronisatie gestopt.");
        },
        log: (m) => this.log(m),
        progress: (progress) => this.updateSyncProgress(progress)
      });
      this.log(dryRun ? "Voorstel wordt berekend." : "Synchronisatie gestart: eerst downloaden.");
      const report = await engine.run(dryRun);
      if (signal.aborted || this.disposed) throw new CancelledError("Synchronisatie gestopt.");
      this.lastError = "";
      this.failures = 0;
      this.nextAuto = Date.now() + this.settings.intervalSeconds * 1e3;
      if (dryRun) {
        this.progressPopup?.finish("success", "Voorstel klaar. Er zijn geen vaultbestanden gewijzigd.");
        this.showPreview(report);
      } else {
        if (this.closeReceipt?.pending()) this.closeReceipt.write(false);
        const message = `${report.pulled} gedownload, ${report.pushed} ge\xFCpload, ${report.conflicts} conflictkopie\xEBn, ${report.deleted} naar prullenbak.`;
        this.log(message);
        if (!closingSignal) this.progressPopup?.finish("success", message);
      }
    } catch (error) {
      const message = errorText(error);
      this.log(message);
      if (!closingSignal && !this.disposed) this.progressPopup?.finish(error instanceof CancelledError ? "cancelled" : "error", message);
      this.failures++;
      this.nextAuto = Date.now() + Math.min(30 * 6e4, this.settings.intervalSeconds * 1e3 * 2 ** Math.min(this.failures - 1, 6));
      if (!(error instanceof CancelledError)) {
        if (!closingSignal && !this.progressPopup && (manual || this.lastError !== message)) new import_obsidian3.Notice(`Drive-sync gestopt: ${message}`, 12e3);
        this.lastError = message;
      }
      if (error instanceof ChangedError) this.nextAuto = Date.now() + 15e3;
      if (closingSignal) throw error;
    } finally {
      closingSignal?.removeEventListener("abort", abort);
      unlock?.();
      this.busy = false;
      this.controller = void 0;
      this.syncProgress = void 0;
      this.renderStatus();
    }
  }
  installCloseSync() {
    const native = window.electronWindow;
    const listener = (event) => this.closeSync?.nativeClose(event);
    if (native && typeof native.on === "function" && typeof native.removeListener === "function") {
      try {
        native.on("close", listener);
        this.closeBridgeAvailable = true;
        this.register(() => {
          try {
            native.removeListener("close", listener);
          } catch {
          }
        });
      } catch (error) {
        this.log(`Afsluitbrug niet beschikbaar: ${errorText(error)}`);
      }
    }
    this.closeSync = new CloseSync({
      enabled: () => {
        try {
          return !this.disposed && this.settings.autoSync && this.settings.syncOnClose && !!this.settings.rootId && this.auth.connected();
        } catch {
          return false;
        }
      },
      timeoutMs: () => this.settings.closeTimeoutSeconds * 1e3,
      start: () => {
        this.closeReceipt.write(true, "Afsluitsync gestart, nog niet bevestigd.");
        if (this.debounce) {
          clearTimeout(this.debounce);
          this.debounce = void 0;
        }
        this.progressPopup?.dispose();
        this.showCloseProgress();
        this.renderStatus();
        this.log("Laatste synchronisatie v\xF3\xF3r afsluiten.");
      },
      work: async (signal) => {
        this.stop();
        await this.operation?.catch(() => void 0);
        if (signal.aborted || this.disposed) throw new CancelledError("Afsluitsync gestopt.");
        this.updateSyncProgress({ phase: "save-editors", completed: 0 });
        await saveOpenEditors(this.app, signal, (progress) => this.updateSyncProgress({ ...progress, phase: "save-editors" }));
        if (this.busy) throw new SyncError("De vorige bewerking is nog niet afgerond.");
        await this.sync(false, false, signal);
      },
      cancel: () => this.stop(),
      finish: (result) => this.finishCloseSync(result),
      close: () => window.close()
    }, this.closeBridgeAvailable);
    this.registerEvent(this.app.workspace.on("quit", (tasks) => this.closeSync?.quit(tasks)));
    if (!this.closeBridgeAvailable) this.log("Afsluitsync heeft alleen een korte best-effort afsluitwachttijd (maximaal 2 seconden).");
  }
  showCloseProgress() {
    this.hideCloseProgress();
    const overlay = document.body.createDiv({ cls: "drive-vault-sync-closing" });
    this.closeOverlay = overlay;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Opslaan v\xF3\xF3r afsluiten");
    const panel = overlay.createDiv({ cls: "drive-vault-sync-close-panel" });
    panel.createEl("h2", { text: "Nog even synchroniseren\u2026" });
    panel.createEl("p", { text: "Open notities opslaan, Drive-wijzigingen ophalen en daarna je wijzigingen uploaden." });
    this.closeProgressPanel = new SyncProgressPanel(panel);
    this.closeProgressPanel.update({ phase: "wait", completed: 0 });
    const remaining = panel.createEl("p");
    remaining.setAttribute("role", "status");
    const deadline = Date.now() + (this.closeBridgeAvailable ? this.settings.closeTimeoutSeconds : 2) * 1e3;
    const update = () => remaining.setText(`Obsidian sluit zodra dit klaar is. Nog maximaal ${Math.max(0, Math.ceil((deadline - Date.now()) / 1e3))} seconden.`);
    update();
    this.closeCountdown = setInterval(update, 1e3);
    const button = panel.createEl("button", { text: "Nu sluiten zonder te wachten" });
    button.addEventListener("click", () => this.closeSync?.skip(), { once: true });
    button.focus();
    panel.createEl("p", { text: "Bij een onderbreking blijven lokale bestanden bewaard. Een volgende sync vergelijkt opnieuw.", cls: "drive-vault-sync-close-hint" });
  }
  hideCloseProgress() {
    if (this.closeCountdown) clearInterval(this.closeCountdown);
    this.closeCountdown = void 0;
    this.closeOverlay?.remove();
    this.closeOverlay = void 0;
    this.closeProgressPanel = void 0;
  }
  finishCloseSync(result) {
    const message = result.kind === "success" ? "Afsluitsync voltooid." : result.kind === "timeout" ? "Wachttijd verstreken; afsluitsync niet bevestigd." : result.kind === "error" ? `Afsluitsync niet afgerond: ${errorText(result.error)}` : "Afsluitsync onderbroken.";
    try {
      this.closeReceipt?.write(result.kind !== "success", message);
    } catch (error) {
      this.log(`Afsluitstatus kon niet worden opgeslagen: ${errorText(error)}`);
    }
    this.log(message);
    this.hideCloseProgress();
    this.renderStatus();
  }
};
function parseFolderId(value) {
  const trimmed = value.trim();
  let id = trimmed;
  if (trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    if (url.hostname !== "drive.google.com") throw new SyncError("Gebruik een Google Drive-maplink.");
    id = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/u)?.[1] ?? "";
  }
  if (!/^[a-zA-Z0-9_-]{10,256}$/u.test(id) || id === "root") throw new SyncError("Plak de ID of link van een aparte vaultmap in Mijn Drive.");
  return id;
}
var label = (kind) => ({ pull: "Downloaden", push: "Uploaden", conflict: "Beide versies bewaren", "delete-local": "Lokaal naar prullenbak", "delete-remote": "Drive naar prullenbak", adopt: "Gelijk", forget: "Aan beide kanten verwijderd" })[kind] ?? kind;
var DriveSettings = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl: el } = this, plugin = this.plugin;
    el.empty();
    el.createEl("h2", { text: "Drive Vault Sync" });
    el.createEl("p", { text: "Tweerichtingssync voor Obsidian Desktop. Drive-wijzigingen worden eerst gedownload. Bij een conflict krijgt jouw lokale versie een aparte bestandsnaam." });
    if (plugin.blocked) el.createEl("p", { text: plugin.blocked, cls: "drive-vault-sync-error" });
    let clientSecretStored = false, connected = false;
    try {
      clientSecretStored = !!plugin.auth.stored().clientSecret;
      connected = plugin.auth.connected();
    } catch {
      el.createEl("p", { text: "De opgeslagen aanmelding is beschadigd. Klik Afmelden en vul daarna de client secret opnieuw in.", cls: "drive-vault-sync-error" });
    }
    const action = (fn) => {
      void fn().then(() => this.display()).catch((error) => new import_obsidian3.Notice(errorText(error), 12e3));
    };
    let client = plugin.settings.clientId, folder = plugin.settings.rootId;
    new import_obsidian3.Setting(el).setName("Desktop OAuth-client-ID").setDesc("Maak een eigen Desktop app-client in Google Cloud; zie LEESMIJ.md voor de volledige installatie.").addText((text) => text.setPlaceholder("\u2026apps.googleusercontent.com").setValue(client).onChange((value) => {
      client = value;
    }));
    new import_obsidian3.Setting(el).setName("Drive-vaultmap").setDesc("Een aparte map in Mijn Drive. Plak de maplink of ID. De inhoud vormt de hoofdmap van je vault.").addText((text) => text.setValue(folder).onChange((value) => {
      folder = value;
    }));
    new import_obsidian3.Setting(el).setName("Verbinding opslaan").setDesc("Een nieuwe map zet automatische sync en verwijderingen uit. Bekijk daarna eerst het voorstel.").addButton((button) => button.setButtonText("Verbinding opslaan").onClick(() => action(() => plugin.configure(client, folder))));
    new import_obsidian3.Setting(el).setName("OAuth-client secret").setDesc("Uit de Desktop OAuth-client. Opgeslagen in Obsidian SecretStorage; komt niet in de vaultinstellingen of Drive. Bewaar eerst de client-ID.").addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "off";
      text.setPlaceholder(clientSecretStored ? "Opgeslagen; leeg laten om te behouden" : "Client secret");
      let secret = "";
      text.onChange((value) => {
        secret = value;
      });
      new import_obsidian3.Setting(el).setName("Client secret bewaren").addButton((button) => button.setButtonText("Bewaren").onClick(() => {
        if (plugin.busy) {
          new import_obsidian3.Notice("Stop eerst de lopende synchronisatie.");
          return;
        }
        if (secret.trim()) {
          plugin.auth.setClientSecret(secret);
          text.setValue("");
          secret = "";
          new import_obsidian3.Notice("Client secret opgeslagen.");
        }
      }));
    });
    new import_obsidian3.Setting(el).setName("Google-account").setDesc(connected ? "Aangemeld. Tokens worden lokaal beheerd in SecretStorage." : "Je browser opent voor Google-toestemming.").addButton((button) => button.setButtonText("Aanmelden").onClick(() => action(() => plugin.login()))).addButton((button) => button.setButtonText("Afmelden").onClick(() => action(() => plugin.disconnect())));
    el.createEl("p", { text: "Google vraagt toegang tot alle Drive-bestanden om ook bestanden te kunnen zien die je zelf in de vaultmap toevoegt. De plugin beperkt zijn bestandsacties tot de ingestelde map. Je inhoud staat als gewone bestanden in Drive; deze versie voegt geen eigen versleuteling toe." });
    new import_obsidian3.Setting(el).setName("Automatisch synchroniseren").setDesc("Bij starten, lokale wijzigingen, focus en periodiek zolang Obsidian open is.").addToggle((toggle) => toggle.setValue(plugin.settings.autoSync).onChange((value) => action(() => plugin.setPaused(!value))));
    new import_obsidian3.Setting(el).setName("Interval").setDesc("Hoe vaak Drive wordt gecontroleerd; minimaal 30 seconden.").addDropdown((dropdown) => dropdown.addOptions({ "30": "30 seconden", "60": "1 minuut", "120": "2 minuten", "300": "5 minuten", "600": "10 minuten", "1800": "30 minuten", "3600": "1 uur" }).setValue(String(plugin.settings.intervalSeconds)).onChange((value) => {
      plugin.settings.intervalSeconds = Number(value);
      action(() => plugin.saveSettings());
    }));
    new import_obsidian3.Setting(el).setName("Synchroniseren bij afsluiten").setDesc("Standaard aan. Slaat open tekstnotities op en doet een laatste sync voordat het vaultvenster sluit. Werkt wanneer automatische synchronisatie aanstaat en Google gekoppeld is; pauzeren pauzeert ook deze sync.").addToggle((toggle) => toggle.setValue(plugin.settings.syncOnClose).onChange((value) => {
      plugin.settings.syncOnClose = value;
      action(() => plugin.saveSettings());
    }));
    new import_obsidian3.Setting(el).setName("Maximaal wachten bij afsluiten").setDesc("Sluit eerder zodra de sync klaar is. Bij een fout of het verstrijken van deze tijd wordt afgesloten; een volgende sync vergelijkt opnieuw.").addDropdown((dropdown) => dropdown.addOptions({ "5": "5 seconden", "15": "15 seconden", "30": "30 seconden (standaard)", "60": "1 minuut", "120": "2 minuten" }).setValue(String(plugin.settings.closeTimeoutSeconds)).onChange((value) => {
      plugin.settings.closeTimeoutSeconds = Number(value);
      action(() => plugin.saveSettings());
    }));
    if (!plugin.closeBridgeAvailable) el.createEl("p", { text: "De afsluitbrug van deze Obsidian-versie is niet beschikbaar. Automatisch wachten is daarom beperkt tot een poging van maximaal 2 seconden. Gebruik Nu synchroniseren v\xF3\xF3r afsluiten.", cls: "drive-vault-sync-error" });
    new import_obsidian3.Setting(el).setName("Verwijderingen doorgeven").setDesc("Standaard uit: verwijderde bestanden worden teruggehaald. Aan: uitsluitend bevestigde, ongewijzigde bestanden gaan naar de prullenbak. Maximaal 10 per ronde; grote verwijdergolven worden geblokkeerd.").addToggle((toggle) => toggle.setValue(plugin.settings.syncDeletes).onChange((value) => {
      if (plugin.busy) {
        new import_obsidian3.Notice("Stop eerst de lopende synchronisatie.");
        this.display();
        return;
      }
      plugin.settings.syncDeletes = value;
      action(() => plugin.saveSettings());
    }));
    let exclusions = plugin.settings.exclude.join("\n");
    new import_obsidian3.Setting(el).setName("Uitsluitingen").setDesc("E\xE9n relatief bestand of mapprefix per regel, zonder wildcards. Verborgen mappen, configuratie, credentials en herstelkopie\xEBn zijn altijd uitgesloten. De limiet is 100 MiB per bestand.").addTextArea((text) => text.setValue(exclusions).onChange((value) => {
      exclusions = value;
    }));
    new import_obsidian3.Setting(el).setName("Uitsluitingen opslaan").addButton((button) => button.setButtonText("Opslaan").onClick(() => action(async () => {
      if (plugin.busy) throw new SyncError("Stop eerst de lopende synchronisatie.");
      const prefixes = [...new Set(exclusions.split(/\r?\n/u).map((v) => v.trim().replace(/\/$/u, "")).filter(Boolean))];
      prefixes.forEach(safePath);
      plugin.settings.exclude = prefixes;
      await plugin.saveSettings();
    })));
    new import_obsidian3.Setting(el).setName("Synchroniseren").addButton((button) => button.setButtonText("Voorstel bekijken").onClick(() => action(() => plugin.sync(true, true)))).addButton((button) => button.setButtonText("Nu synchroniseren").setCta().onClick(() => action(() => plugin.sync(false, true)))).addButton((button) => button.setButtonText("Stoppen").onClick(() => plugin.stop()));
    new import_obsidian3.Setting(el).setName("Herstel en activiteit").addButton((button) => button.setButtonText("Herstelkopie\xEBn").onClick(() => action(() => plugin.openRecovery()))).addButton((button) => button.setButtonText("Activiteit").onClick(() => plugin.showLog()));
    new import_obsidian3.Setting(el).setName("Koppeling opnieuw beginnen").setDesc("Alleen de vergelijkingsgeschiedenis wordt opnieuw opgebouwd. Bij afwijkende inhoud worden beide versies bewaard. Automatische sync en verwijderen gaan uit.").addButton((button) => button.setButtonText("Geschiedenis opnieuw opbouwen").onClick(() => action(() => plugin.resetBaseline())));
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseFolderId
});
