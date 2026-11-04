import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startPanel, type PanelProcess } from './helpers/panel-process.js';

describe('Cloudflare: восстановление дополнительного HTTPS-входа на настоящем процессе', () => {
  let first: PanelProcess;
  let panel: PanelProcess;
  let port: number;
  const request = (urlPath: string) => new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: urlPath, rejectUnauthorized: false, agent: false,
      headers: { Authorization: `Bearer ${panel.token}` } }, (res) => {
      let body = ''; res.on('data', (s) => body += s); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body), headers: res.headers }));
    }).on('error', reject);
  });
  beforeAll(async () => {
    first = await startPanel();
    expect((await first.api('/api/security/ssl/issue-ip', 'POST', { ip: 'panel.example.com' })).status).toBe(200);
    for (const candidate of [8443, 2087, 2096, 2053, 2083]) {
      const free = await new Promise<boolean>((resolve) => {
        const server = net.createServer(); server.once('error', () => resolve(false));
        server.listen(candidate, () => server.close(() => resolve(true)));
      });
      if (free) { port = candidate; break; }
    }
    expect(port).toBeTruthy();
    const db = new DatabaseSync(path.join(first.dataDir, 'dementia.db'));
    for (const [key, value] of Object.entries({ cf_panel_enabled: '1', cf_panel_domain: 'panel.example.com', cf_panel_port: String(port) })) {
      db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(key, value);
    }
    db.close();
    const exited = new Promise<void>((resolve) => first.child.once('exit', () => resolve()));
    first.child.kill(); await exited;
    panel = await startPanel({ DEMENTIA_DATA_DIR: first.dataDir });
    panel.token = first.token; // Session and certificate survive the restart; the helper's plain HTTP login is now intentionally rejected.
    await eventually(async () => expect((await request('/api/health')).status).toBe(200));
  }, 60000);
  afterAll(async () => {
    await panel?.stop();
    if (first && first.child.exitCode === null && first.child.signalCode === null) await first.stop();
    else if (first) fs.rmSync(first.dataDir, { recursive: true, force: true });
  });

  it('обслуживает тот же API по HTTPS на дополнительном порту, сохраняя основной вход', async () => {
    const extra = await request('/api/auth/me');
    expect(extra.status).toBe(200); expect(extra.body.user.username).toBe('process_admin');
    expect(extra.headers['cloudflare-cdn-cache-control']).toBe('no-store');
    expect(extra.headers['strict-transport-security']).toBeTruthy();
    expect((await panel.request({ path: '/api/auth/me', authed: true, tls: true })).status).toBe(200);
    expect((await panel.request({ path: '/api/health' })).status).toBe(200);
  });
  it('живые обновления авторизуются через WSS на том же дополнительном порту', async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('error', reject);
        ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token: panel.token })));
        ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'auth_ok') resolve(); });
      });
    } finally { ws.close(); }
  }, 10000);
});
