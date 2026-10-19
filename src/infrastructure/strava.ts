import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { exec } from 'node:child_process';
import type { ActivityUploader, UploadResult } from '../application/ports.js';

const API = 'https://www.strava.com';
const REDIRECT_PORT = 8723;
// 127.0.0.1 (not "localhost") so the browser can't wander off to ::1; Strava whitelists both.
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

interface Tokens { access_token: string; refresh_token: string; expires_at: number; athlete?: { firstname?: string; lastname?: string } }
interface StoredAuth { clientId: string; clientSecret: string; tokens?: Tokens }

/** API app credentials + OAuth tokens, stored as JSON (mode 0600). */
export class StravaTokenFile {
  constructor(readonly path: string) {}

  static in(appDir: string) { return new StravaTokenFile(join(appDir, 'strava.json')); }

  async read(): Promise<StoredAuth | undefined> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); } catch { return undefined; }
  }

  async write(a: StoredAuth) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(a, null, 2), { mode: 0o600 });
  }
}

export class StravaClient implements ActivityUploader {
  constructor(private store: StravaTokenFile, private log: (s: string) => void = console.log) {}

  /**
   * OAuth authorization-code flow with a loopback redirect.
   * Create an app at https://www.strava.com/settings/api with "Authorization Callback Domain" = 127.0.0.1.
   */
  async auth(clientId: string, clientSecret: string): Promise<Tokens> {
    const state = Math.random().toString(36).slice(2);
    const url = `${API}/oauth/authorize?` + new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code',
      approval_prompt: 'auto', scope: 'activity:write,read', state,
    });

    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', REDIRECT_URI);
        if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const err = u.searchParams.get('error');
        const c = u.searchParams.get('code');
        const ok = !err && c && u.searchParams.get('state') === state && (u.searchParams.get('scope') ?? '').includes('activity:write');
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
          .end(ok ? '<h2>trainer-cli is connected to Strava ✔</h2>You can close this tab.' : `<h2>Authorization failed</h2>${err ?? 'missing activity:write scope or bad state'}`);
        server.close();
        ok ? resolve(c!) : reject(new Error(err ?? 'Authorization failed (activity:write scope is required — leave the "Upload your activities" box ticked)'));
      });
      server.on('error', reject);
      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        this.log(`Opening Strava in your browser. If it doesn't open, visit:\n  ${url}`);
        this.openBrowser(url);
      });
      setTimeout(() => { server.close(); reject(new Error('Timed out waiting for Strava authorization (5 min)')); }, 5 * 60_000).unref();
    });

    const tokens = await this.tokenRequest({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' });
    await this.store.write({ clientId, clientSecret, tokens });
    return tokens;
  }

  async status(): Promise<string> {
    const a = await this.store.read();
    if (!a?.tokens) return 'not connected — run "trainer strava auth"';
    const who = [a.tokens.athlete?.firstname, a.tokens.athlete?.lastname].filter(Boolean).join(' ');
    return `connected${who ? ` as ${who}` : ''} (client ${a.clientId})`;
  }

  async isConnected() { return !!(await this.store.read())?.tokens; }

  async upload(file: string, opts: { name?: string; description?: string; indoor: boolean }): Promise<UploadResult & { activityId: number }> {
    const token = await this.accessToken();
    const form = new FormData();
    form.set('file', new Blob([await readFile(file)]), basename(file));
    form.set('data_type', file.toLowerCase().endsWith('.fit.gz') ? 'fit.gz' : 'fit');
    form.set('external_id', basename(file));
    if (opts.name) form.set('name', opts.name);
    form.set('description', opts.description ?? 'Recorded with trainer-cli');
    if (opts.indoor) form.set('trainer', '1');

    const res = await fetch(`${API}/api/v3/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
    let up = await res.json() as { id: number; error: string | null; status: string; activity_id: number | null };
    this.log(`uploaded, ${up.status.toLowerCase()}…`);

    for (let i = 0; i < 30 && !up.activity_id && !up.error; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const r = await fetch(`${API}/api/v3/uploads/${up.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`Upload status failed: ${r.status}`);
      up = await r.json() as typeof up;
    }
    if (up.error) throw new Error(`Strava rejected the file: ${up.error}`);
    if (!up.activity_id) throw new Error(`Strava is still processing upload ${up.id} — check your feed in a minute`);
    return { activityId: up.activity_id, url: `https://www.strava.com/activities/${up.activity_id}` };
  }

  /** Valid access token, refreshed when it's about to expire. */
  private async accessToken(): Promise<string> {
    const a = await this.store.read();
    if (!a?.tokens) throw new Error('Not connected to Strava — run "trainer strava auth" first');
    if (a.tokens.expires_at - 120 > Date.now() / 1000) return a.tokens.access_token;
    const t = await this.tokenRequest({ client_id: a.clientId, client_secret: a.clientSecret, grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token });
    await this.store.write({ ...a, tokens: { ...a.tokens, ...t } });
    return t.access_token;
  }

  private async tokenRequest(body: Record<string, string>): Promise<Tokens> {
    const res = await fetch(`${API}/oauth/token`, { method: 'POST', body: new URLSearchParams(body) });
    if (!res.ok) throw new Error(`Strava token request failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Tokens>;
  }

  private openBrowser(url: string) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${cmd} "${url}"`, () => undefined);
  }
}
