import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { isValidSignature } from '../src/utils/awg-params.js';
import { generateSignature, normalizeSignatureDomain, quicInitialKeys } from '../src/utils/awg-signatures.js';
import { createAdminApi } from './helpers/api.js';
import { getServer, insertClient } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';
import { startTestServer } from './test-app.js';

/**
 * Пресеты сигнатурных пакетов I1: пакет QUIC Initial расшифровывается здесь так, как это сделал бы DPI
 * (ключи из DCID), и в нём должен быть ClientHello с заданным SNI.
 */

/** Разбор значения I1: байты тегов <b …> и суммарная длина пакета с учётом <r N> */
function parseSignature(value: string): { bytes: Buffer; random: number; total: number } {
  const parts: Buffer[] = [];
  let random = 0;
  for (const tag of value.match(/<[^>]+>/g) ?? []) {
    const bytes = /^<b 0x([0-9a-f]+)>$/.exec(tag);
    const rand = /^<r (\d+)>$/.exec(tag);
    if (bytes) parts.push(Buffer.from(bytes[1], 'hex'));
    else if (rand) random += Number(rand[1]);
    else throw new Error(`неожиданный тег ${tag}`);
  }
  const bytes = Buffer.concat(parts);
  return { bytes, random, total: bytes.length + random };
}

/** Снятие защиты пакета QUIC Initial стороной, которая знает только сам пакет (RFC 9001, 5) */
function decryptQuicInitial(packet: Buffer): Buffer {
  expect(packet[0] & 0xf0).toBe(0xc0); // длинный заголовок, тип Initial
  expect(packet.subarray(1, 5).toString('hex')).toBe('00000001');
  const dcidLength = packet[5];
  const dcid = packet.subarray(6, 6 + dcidLength);
  let offset = 6 + dcidLength;
  offset += 1 + packet[offset]; // SCID
  expect(packet[offset]).toBe(0); // токена нет
  offset += 1;
  const length = packet.readUInt16BE(offset) & 0x3fff;
  offset += 2;
  expect(offset + length).toBe(packet.length);

  const { key, iv, hp } = quicInitialKeys(dcid);
  const ecb = crypto.createCipheriv('aes-128-ecb', hp, null);
  ecb.setAutoPadding(false);
  const mask = ecb.update(packet.subarray(offset + 4, offset + 20));
  const header = Buffer.from(packet.subarray(0, offset + 1));
  header[0] ^= mask[0] & 0x0f;
  expect(header[0] & 0x03).toBe(0); // номер пакета — один байт
  header[offset] ^= mask[1];

  const nonce = Buffer.from(iv);
  nonce[11] ^= header[offset];
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(packet.subarray(packet.length - 16));
  return Buffer.concat([decipher.update(packet.subarray(offset + 1, packet.length - 16)), decipher.final()]);
}

/** SNI из ClientHello внутри кадра CRYPTO */
function sniFromCryptoFrame(payload: Buffer): string {
  expect(payload[0]).toBe(0x06);
  expect(payload[1]).toBe(0); // смещение 0
  const helloLength = payload.readUInt16BE(2) & 0x3fff;
  const hello = payload.subarray(4, 4 + helloLength);
  expect(4 + helloLength).toBe(payload.length);
  expect(hello[0]).toBe(0x01); // ClientHello
  expect(hello.readUIntBE(1, 3)).toBe(hello.length - 4);
  let pos = 4 + 2 + 32; // версия, random
  pos += 1 + hello[pos]; // session id
  pos += 2 + hello.readUInt16BE(pos); // шифры
  pos += 1 + hello[pos]; // сжатие
  const end = pos + 2 + hello.readUInt16BE(pos);
  expect(end).toBe(hello.length);
  pos += 2;
  let sni = '';
  while (pos < end) {
    const type = hello.readUInt16BE(pos);
    const size = hello.readUInt16BE(pos + 2);
    if (type === 0) sni = hello.subarray(pos + 9, pos + 4 + size).toString('ascii');
    pos += 4 + size;
  }
  expect(pos).toBe(end);
  return sni;
}

describe('пресеты сигнатурных пакетов', () => {
  it('ключи Initial совпадают с тестовым вектором RFC 9001 (приложение A.1)', () => {
    const keys = quicInitialKeys(Buffer.from('8394c8f03e515708', 'hex'));
    expect(keys.key.toString('hex')).toBe('1f369613dd76d5467730efcbe3b1a22d');
    expect(keys.iv.toString('hex')).toBe('fa044b2f42a3fd3b46fb255c');
    expect(keys.hp.toString('hex')).toBe('9f50449e04a0e810283a1e9933adedd2');
  });

  it('quic: датаграмма 1200 байт, пакет расшифровывается, в ClientHello — заданный SNI', () => {
    for (const domain of ['example.com', 'a.b', `${'x'.repeat(63)}.${'y'.repeat(63)}.example.org`]) {
      const value = generateSignature('quic', domain);
      expect(isValidSignature(value)).toBe(true);
      const { bytes, total } = parseSignature(value);
      expect(total).toBe(1200);
      expect(sniFromCryptoFrame(decryptQuicInitial(bytes))).toBe(domain);
    }
  });

  it('quic: каждый раз новый пакет; изменённый пакет не проходит проверку подлинности', () => {
    const first = generateSignature('quic', 'example.com');
    expect(generateSignature('quic', 'example.com')).not.toBe(first);
    const { bytes } = parseSignature(first);
    bytes[bytes.length - 20] ^= 1;
    expect(() => decryptQuicInitial(bytes)).toThrow();
  });

  it('dns: запрос A-записи со случайным идентификатором', () => {
    const value = generateSignature('dns', 'www.example.com');
    expect(isValidSignature(value)).toBe(true);
    expect(value.startsWith('<r 2>')).toBe(true);
    const { bytes, random } = parseSignature(value);
    expect(random).toBe(2);
    expect(bytes.toString('hex')).toBe(
      '01000001000000000000' + '03777777' + '076578616d706c65' + '03636f6d' + '00' + '00010001'
    );
  });

  it('stun: Binding Request с magic cookie и 12 случайными байтами', () => {
    const value = generateSignature('stun', null);
    expect(isValidSignature(value)).toBe(true);
    const { bytes, total } = parseSignature(value);
    expect(bytes.toString('hex')).toBe('000100002112a442');
    expect(total).toBe(20);
  });

  it('домен: только корректное имя, без IP, пробелов и переводов строк', () => {
    expect(normalizeSignatureDomain(' Example.COM. ')).toBe('example.com');
    expect(normalizeSignatureDomain('xn--e1afmkfd.xn--p1ai')).toBe('xn--e1afmkfd.xn--p1ai');
    for (const bad of ['', 'localhost', '1.2.3.4', 'пример.рф', 'a..b', '-a.com', 'a.com\nPostUp = id', 'a b.com', `${'x'.repeat(64)}.com`, 5, null]) {
      expect(normalizeSignatureDomain(bad)).toBeNull();
    }
  });
});

describe('API пресетов и сохранение I1–I5', () => {
  let env: Awaited<ReturnType<typeof startTestServer>>;
  let admin: ReturnType<typeof createAdminApi>;

  beforeAll(async () => {
    initDatabase();
    env = await startTestServer();
    admin = createAdminApi(env, 'admin_signatures');
  });
  afterAll(async () => {
    await env.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const newServer = (host: string) => ({ name: 'S', host, ssh_password: 'super-secret-ssh-password' });

  it('POST /awg-signature проверяет пресет и домен', async () => {
    expect((await admin.api('/api/servers/awg-signature', 'POST', { preset: 'http', domain: 'example.com' })).status).toBe(400);
    expect((await admin.api('/api/servers/awg-signature', 'POST', { preset: 'quic' })).status).toBe(400);
    expect((await admin.api('/api/servers/awg-signature', 'POST', { preset: 'dns', domain: '1.2.3.4' })).status).toBe(400);
    expect((await admin.api('/api/servers/awg-signature', 'POST', { preset: 'stun' })).body.i1).toBe('<b 0x000100002112a442><r 12>');
    const quic = await admin.api('/api/servers/awg-signature', 'POST', { preset: 'quic', domain: 'Example.com' });
    expect(quic.status).toBe(200);
    expect(sniFromCryptoFrame(decryptQuicInitial(parseSignature(quic.body.i1).bytes))).toBe('example.com');
  });

  it('смена только I1–I5 не перезапускает AmneziaWG на ноде; вместе с серверным параметром — перезапускает', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer('sig-1.example.com'))).body.id;
    db.prepare("UPDATE servers SET status = 'online', deployed_port = awg_port WHERE id = ?").run(id);
    const ssh = stubSsh();
    const i1 = generateSignature('quic', 'example.com');

    const res = await admin.api(`/api/servers/${id}`, 'PUT', { i1, i2: '<r 40>' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ i1, i2: '<r 40>' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ssh.calls).toHaveLength(0);
    expect(getServer(id).needs_apply).toBe(0);

    expect((await admin.api(`/api/servers/${id}`, 'PUT', { i1: null, jc: getServer(id).jc === 9 ? 8 : 9 })).status).toBe(200);
    await vi.waitFor(() => expect(ssh.calls.some((c) => c.command.includes('docker restart'))).toBe(true));
    expect(getServer(id).i1).toBeNull();
  });

  it('конфигурация с пресетом QUIC помещается в QR-код; слишком длинная — понятная ошибка, а не 500', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer('sig-2.example.com'))).body.id;
    const client = insertClient(id);
    const i1 = generateSignature('quic', 'a-rather-long-subdomain.of-some.popular-website.example.com');
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { i1 })).status).toBe(200);

    const qr = await admin.api(`/api/clients/${client.id}/qrcode`);
    expect(qr.status).toBe(200);
    expect(qr.body.config).toContain(`I1 = ${i1}`);

    db.prepare('UPDATE servers SET i1 = ? WHERE id = ?').run(`<b 0x${'ab'.repeat(1500)}>`, id);
    const tooBig = await admin.api(`/api/clients/${client.id}/qrcode`);
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error).toContain('QR');
  });
});
