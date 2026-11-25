import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config.js';
import { panelEnv } from '../utils/env.js';

const PREFIX = 'enc:v1:';
let cachedKey: Buffer | null = null;

/**
 * Мастер-ключ шифрования секретов в БД: DEMENTIA_SECRET_KEY (base64, 32 байта)
 * или файл data/secret.key, создаваемый при первом запуске с правами 600.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = panelEnv('SECRET_KEY');
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64');
    if (key.length !== 32) {
      throw new Error('DEMENTIA_SECRET_KEY должен содержать 32 байта в base64');
    }
    cachedKey = key;
    return key;
  }

  const keyFile = path.join(dataDir, 'secret.key');
  if (fs.existsSync(keyFile)) {
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf-8').trim(), 'base64');
    if (key.length !== 32) {
      throw new Error('Файл secret.key повреждён: ожидается 32 байта в base64');
    }
    cachedKey = key;
  } else {
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, cachedKey.toString('base64'), { mode: 0o600 });
  }
  return cachedKey;
}

/** Действующий мастер-ключ (base64) — для переноса панели на другой сервер */
export function exportSecretKey(): string {
  return getKey().toString('base64');
}

export function encryptSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value.startsWith(PREFIX)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!value.startsWith(PREFIX)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf-8');
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}
