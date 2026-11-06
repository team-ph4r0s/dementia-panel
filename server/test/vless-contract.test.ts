import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateVlessParams,
  isValidUuid,
  toXrayKey,
  validateVlessParams,
  vlessParamsFromRow,
  vlessParamsToColumns,
} from '../src/utils/vless-params.js';

/** Общий контракт VLESS (этап 0): миграция v15 и проверка параметров Reality */

const dirs: string[] = [];
const openDbs: { close(): void }[] = [];

afterEach(() => {
  for (const handle of openDbs.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function openAt(targetVersion?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-vless-'));
  dirs.push(dir);
  process.env.DEMENTIA_DATA_DIR = dir;
  vi.resetModules();
  const dbModule = await import('../src/db/index.js');
  openDbs.push(dbModule.db);
  dbModule.initDatabase(targetVersion);
  return dbModule;
}

describe('миграция v15 (VLESS)', () => {
  it('существующие ноды остаются AWG, клиентов VLESS без IP и ключа можно несколько, UUID уникален', async () => {
    const { db, initDatabase } = await openAt(14);
    db.prepare("INSERT INTO servers (name, host) VALUES ('old', '198.51.100.1')").run();
    initDatabase();
    expect((db.prepare('SELECT protocol FROM servers').get() as any).protocol).toBe('awg');

    const server = db.prepare("INSERT INTO servers (name, host, protocol) VALUES ('v', '198.51.100.2', 'vless')").run().lastInsertRowid;
    const insert = db.prepare(
      "INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key, client_uuid) VALUES (?, ?, '', '', '', ?)",
    );
    insert.run(server, 'a', '11111111-1111-4111-8111-111111111111');
    insert.run(server, 'b', '22222222-2222-4222-8222-222222222222');
    expect(() => insert.run(server, 'c', '22222222-2222-4222-8222-222222222222')).toThrow();

    // Для AWG уникальность IP и ключа сохраняется
    const awg = db.prepare("INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key) VALUES (1, ?, ?, ?, '')");
    awg.run('x', '10.8.0.2', 'key1');
    expect(() => awg.run('y', '10.8.0.2', 'key2')).toThrow();
    expect(() => awg.run('z', '10.8.0.3', 'key1')).toThrow();
  });
});

describe('параметры VLESS', () => {
  it('сгенерированные параметры проходят проверку и переживают запись в колонки', () => {
    const params = generateVlessParams();
    expect(validateVlessParams(params)).toBeNull();
    expect(vlessParamsFromRow(vlessParamsToColumns(params))).toEqual(params);
  });

  it('отклоняет значения, способные сломать config.json или ссылку', () => {
    const base = generateVlessParams();
    expect(validateVlessParams({ ...base, reality_sni: 'evil.com\nflow=x' })).not.toBeNull();
    expect(validateVlessParams({ ...base, reality_dest: 'example.com' })).not.toBeNull();
    expect(validateVlessParams({ ...base, reality_dest: 'example.com:70000' })).not.toBeNull();
    expect(validateVlessParams({ ...base, reality_short_ids: ['abc'] })).not.toBeNull();
    expect(validateVlessParams({ ...base, reality_short_ids: [] })).not.toBeNull();
    expect(validateVlessParams({ ...base, xray_flow: 'other' as any })).not.toBeNull();
    expect(validateVlessParams({ ...base, xray_fingerprint: 'chrome"' })).not.toBeNull();
  });

  it('ключ переводится в base64url без выравнивания, UUID проверяется строго', () => {
    const key = Buffer.alloc(32, 0xfb).toString('base64');
    expect(toXrayKey(key)).toBe(Buffer.alloc(32, 0xfb).toString('base64url'));
    expect(toXrayKey(key)).not.toMatch(/[+/=]/);
    expect(isValidUuid(crypto.randomUUID())).toBe(true);
    expect(isValidUuid('not-a-uuid')).toBe(false);
  });
});
