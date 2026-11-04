import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// Run the actual shell script against a stateful Docker CLI double, including its EXIT trap.
const dirs: string[] = [];
const oldImage = `sha256:${'a'.repeat(64)}`;
const newImage = `sha256:${'b'.repeat(64)}`;
const dump = 'PRIVATE\tPUBLIC\t51820\toff\nPEER1\tPSK1\t(none)\t10.8.0.2/32\t0\t5\t10\toff\nIMPORTED\tPSK2\t(none)\t10.8.0.3/32\t0\t0\t0\t25\n';
const conf = '[Interface]\nPrivateKey = PRIVATE\nListenPort = 51820\n[Peer]\nPublicKey = PEER1\nPresharedKey = PSK1\nAllowedIPs = 10.8.0.2/32\n[Peer]\nPublicKey = IMPORTED\nPresharedKey = PSK2\nAllowedIPs = 10.8.0.3/32\nPersistentKeepalive = 25\n';

function run(options: { mode?: string; same?: boolean; fail?: string; mismatch?: boolean; runtimeOnly?: boolean; backup?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-update-script-')); dirs.push(dir);
  const stateFile = path.join(dir, 'state.json');
  const state = {
    containers: { 'amnezia-awg': { image: oldImage, running: true, restart: 'always' }, ...(options.backup ? { 'amnezia-awg-dementia-update-backup': { image: oldImage, running: false } } : {}) },
    calls: [] as string[][], fail: options.fail, mismatch: options.mismatch,
    latest: options.same ? oldImage : newImage, dump, conf: options.runtimeOnly ? conf.replace('PublicKey = IMPORTED', 'PublicKey = DIFFERENT') : conf,
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(path.join(dir, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const p = process.env.DOCKER_TEST_STATE;
const s = JSON.parse(fs.readFileSync(p));
const a = process.argv.slice(2); s.calls.push(a);
let out = '', code = 0;
const c = s.containers;
const name = a.at(-1);
if (s.fail && a[0] === s.fail && !s.failed) { s.failed = true; code = 1; }
else if (a[0] === 'inspect') {
  if (!c[name]) code = 1;
  else if (a.includes('-f')) {
    const f = a[a.indexOf('-f') + 1];
    if (f.includes('.State.Running')) out = String(c[name].running);
    else if (f.includes('.Mounts')) out = '/opt/amnezia/awg';
    else if (f.includes('.Path')) out = '/opt/amnezia/awg/start.sh';
    else if (f.includes('RestartPolicy')) out = c[name].restart;
    else if (f.includes('RestartCount')) out = '0';
    else out = c[name].image;
  }
} else if (a[0] === 'image') out = s.latest;
else if (a[0] === 'exec') {
  if (!c[a[1]]?.running) code = 1;
  else if (a[2] === 'awg-quick') out = s.conf;
  else out = s.mismatch && c[a[1]].image === s.latest ? s.dump.replace('10.8.0.3/32', '10.8.0.99/32') : s.dump;
} else if (a[0] === 'update') { if (c[name]) c[name].restart = a[2]; else code = 1; }
else if (a[0] === 'rename') { if (!c[a[1]] || c[a[2]]) code = 1; else { c[a[2]] = c[a[1]]; delete c[a[1]]; } }
else if (a[0] === 'stop') { if (!c[name]) code = 1; else c[name].running = false; }
else if (a[0] === 'start') { if (!c[name]) code = 1; else c[name].running = true; }
else if (a[0] === 'rm') { if (!c[name]) code = 1; else delete c[name]; }
else if (a[0] === 'run') { const n = a[a.indexOf('--name')+1]; if (c[n]) code = 1; else c[n] = { image: name, running: true, restart: 'always' }; }
fs.writeFileSync(p, JSON.stringify(s));
if (out) process.stdout.write(out + (out.endsWith('\\n') ? '' : '\\n'));
process.exit(code);
`, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const result = spawnSync('bash', [path.resolve('src/scripts/update-awg.sh')], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_TEST_STATE: stateFile,
      AWG_CONTAINER: 'amnezia-awg', AWG_PORT: '51820', AWG_MODE: options.mode ?? 'update' }, encoding: 'utf8', timeout: 60000,
  });
  return { ...result, state: JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('update-awg.sh: настоящая последовательность Docker и откат', () => {
  it('скачивает образ до остановки и запускает новый по immutable ID, проверяя импортированные пиры', () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('---DEMENTIA_UPDATED---');
    expect(r.stdout).not.toMatch(/PRIVATE|PSK1|PSK2/);
    expect(r.state.containers).toEqual({ 'amnezia-awg': { image: newImage, running: true, restart: 'always' } });
    expect(r.state.calls.findIndex((c: string[]) => c[0] === 'pull')).toBeLessThan(r.state.calls.findIndex((c: string[]) => c[0] === 'stop'));
    expect(r.state.conf).toBe(conf);
  }, 60000);
  it.each([{ mode: 'check' }, { same: true }])('не перезапускает контейнер при проверке или неизменном образе: %j', (o) => {
    const r = run(o);
    expect(r.status, r.stderr).toBe(0);
    expect(r.state.calls.some((c: string[]) => ['stop', 'run', 'rename', 'rm'].includes(c[0]))).toBe(false);
  }, 60000);
  it.each(['pull', 'rename', 'stop', 'run'])('ошибка %s оставляет или восстанавливает старый контейнер с ключами', (fail) => {
    const r = run({ fail });
    expect(r.status).not.toBe(0);
    expect(r.state.containers).toEqual({ 'amnezia-awg': { image: oldImage, running: true, restart: 'always' } });
    expect(r.state.conf).toBe(conf);
  }, 60000);
  it('если изменился IP импортированного пира, удаляет новый контейнер и проверяет восстановленные пиры', () => {
    const r = run({ mismatch: true });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('---DEMENTIA_ROLLED_BACK---');
    expect(r.stdout).not.toContain('---DEMENTIA_UPDATED---');
    expect(r.state.containers).toEqual({ 'amnezia-awg': { image: oldImage, running: true, restart: 'always' } });
  }, 60000);
  it('не останавливает контейнер, если пиры меняли вручную только в памяти', () => {
    const r = run({ runtimeOnly: true });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('обновление отменено до остановки');
    expect(r.state.calls.some((c: string[]) => c[0] === 'stop')).toBe(false);
  }, 60000);
  it('сохраняет резервный контейнер незавершённого обновления и требует проверки', () => {
    const r = run({ backup: true });
    expect(r.status).not.toBe(0);
    expect(Object.keys(r.state.containers)).toHaveLength(2);
    expect(r.state.calls.some((c: string[]) => c[0] === 'rm')).toBe(false);
  }, 60000);
});
