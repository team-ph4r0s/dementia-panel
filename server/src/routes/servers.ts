import { CdnService } from '../services/cdn.service.js';
import { Router } from 'express';
import { db, transaction, getSetting } from '../db/index.js';
import { AwgService, AwgParams } from '../services/awg.service.js';
import { SshService } from '../services/ssh.service.js';
import { ProvisionService } from '../services/provision.service.js';
import { NodeUpdateService } from '../services/node-update.service.js';
import { encryptSecret } from '../services/secrets.service.js';
import { asyncHandler, HttpError, parseId } from '../utils/http.js';
import { isValidHost, isValidPort, parseSubnet } from '../utils/net.js';
import { LATEST_AWG_VERSION, paramsFromRow, paramsToColumns } from '../utils/awg-params.js';
import { generateSignature, normalizeSignatureDomain, SIGNATURE_PRESETS, SignaturePreset } from '../utils/awg-signatures.js';
import { AmneziaKeyError, decodeAmneziaKey, splitAmneziaKeys } from '../utils/amnezia-key.js';
import { ProbeService } from '../services/probe.service.js';
import { EventService } from '../services/event.service.js';
import {
  DEFAULT_VLESS_PORT, generateVlessParams, NODE_PROTOCOLS, NodeProtocol, nodeProtocol,
  validateVlessParams, vlessParamsFromRow, vlessParamsToColumns, XRAY_API_PORT, XRAY_CONF_PATH, XRAY_CONTAINER,
} from '../utils/vless-params.js';

export const serversRouter = Router();

/** Параметры обфускации, редактируемые через PUT (версия протокола меняется отдельным действием) */
const INT_PARAM_KEYS = ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4'] as const;
const TEXT_PARAM_KEYS = ['h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5', 'header_protection_key'] as const;
/** I1–I5 есть только в конфигурации клиента (renderAwgLines): их смена не требует перезапуска AmneziaWG на ноде */
const CLIENT_ONLY_PARAM_KEYS: ReadonlySet<string> = new Set(['i1', 'i2', 'i3', 'i4', 'i5']);

/**
 * Представление сервера для фронтенда — без паролей и приватных ключей
 */
export function serializeServer(s: any) {
  if (!s) return s;
  // cdn_key — приватный ключ сертификата входа через CDN, cdn_cert не нужен интерфейсу (инвариант 1)
  const { ssh_password, ssh_key, server_private_key, preshared_key, extra_params, cdn_key, cdn_cert, ...rest } = s;
  const params = paramsFromRow(s);
  const remotePanel = s.remote_panel_id
    ? (db.prepare('SELECT name, status FROM remote_panels WHERE id = ?').get(s.remote_panel_id) as any)
    : null;
  return {
    ...rest,
    ...params,
    protocol: nodeProtocol(s),
    ...(nodeProtocol(s) === 'vless' ? vlessParamsFromRow(s) : {}),
    latest_awg_version: LATEST_AWG_VERSION,
    remote_panel_name: remotePanel?.name ?? null,
    remote_panel_status: remotePanel?.status ?? null,
    has_ssh_password: Boolean(ssh_password),
    has_ssh_key: Boolean(ssh_key),
    cdn_enabled: Boolean(s.cdn_enabled),
    cdn_cert_ready: Boolean(cdn_cert && cdn_key),
    needs_sync: Boolean(s.needs_sync),
    needs_apply: Boolean(s.needs_apply),
    installing: ProvisionService.isInstalling(s.id),
    node_update: s.remote_panel_id ? null : NodeUpdateService.state(s.id),
    // Доступность из выбранных стран (пусто, пока проверка выключена)
    probes: ProbeService.resultsFor(s.id),
  };
}

function getServerOr404(id: number): any {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as any;
  if (!server) throw new HttpError(404, 'Сервер не найден');
  return server;
}

/**
 * Нодами партнёра управляет панель владельца: SSH, установка и параметры здесь недоступны
 */
function getLocalServerOr404(id: number): any {
  const server = getServerOr404(id);
  if (server.remote_panel_id) {
    throw new HttpError(400, 'Это нода партнёра: её настройками управляет владелец. Отключить её можно в разделе «Партнёры».');
  }
  return server;
}

function selectServerWithCounts(id: number) {
  return db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id) as client_count,
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id AND enabled = 1) as active_client_count
    FROM servers s WHERE s.id = ?
  `).get(id);
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Имя сервера обязательно');
  if (name.trim().length > 64) throw new HttpError(400, 'Имя сервера не длиннее 64 символов');
  return name.trim();
}

function validateSshUser(user: unknown): string {
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) {
    throw new HttpError(400, 'Некорректное имя SSH-пользователя');
  }
  return user;
}

function validatePort(value: unknown, label: string): number {
  const port = Number(value);
  if (!isValidPort(port)) throw new HttpError(400, `${label} должен быть числом от 1 до 65535`);
  return port;
}

function validateNodePort(value: unknown, protocol: NodeProtocol): number {
  const port = validatePort(value, protocol === 'vless' ? 'Порт VLESS' : 'Порт AmneziaWG');
  if (protocol === 'vless' && port === XRAY_API_PORT) throw new HttpError(400, 'Этот порт зарезервирован для API Xray');
  return port;
}

function validateSubnet(value: unknown): string {
  try {
    parseSubnet(String(value));
    return String(value).trim();
  } catch (err: any) {
    throw new HttpError(400, err.message);
  }
}

/**
 * Два сервера с одним адресом и портом AmneziaWG управляли бы одним и тем же контейнером на ноде
 */
function assertEndpointFree(host: string, awgPort: number, protocol: NodeProtocol, exceptId = 0): void {
  const label = protocol === 'vless' ? 'VLESS' : 'AmneziaWG';
  if (getSetting('cf_panel_enabled') === '1' && host.toLowerCase().replace(/\.$/, '') === getSetting('cf_panel_domain')) {
    throw new HttpError(409, `Это проксируемый домен панели. Для ${label} укажите IP или отдельный домен без проксирования Cloudflare.`);
  }
  const duplicate = db.prepare(
    'SELECT id FROM servers WHERE LOWER(host) = LOWER(?) AND awg_port = ? AND protocol = ? AND remote_panel_id IS NULL AND id != ?'
  ).get(host, awgPort, protocol, exceptId);
  if (duplicate) throw new HttpError(409, `Сервер ${host} с портом ${label} ${awgPort} уже добавлен в панель`);
}

const sameValue = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (a != null && b != null && String(a) === String(b));

/**
 * Применяет на ноде изменённые порт, подсеть или параметры обфускации. Если применить не удалось, в БД возвращаются прежние
 * значения: иначе подписки раздавали бы клиентам порт и параметры, которых на ноде нет, и VPN пропал бы у всех. Нода
 * могла успеть получить часть изменений, поэтому needs_apply остаётся: фоновый опрос приведёт её к прежним параметрам.
 * Возвращает текст ошибки или null.
 */
async function applyOrRollback(id: number, previous: Record<string, unknown>, written: Record<string, unknown>): Promise<string | null> {
  const result = await ProvisionService.requestApply(id);
  if (result.success) return null;

  const keys = Object.keys(written);
  // Откат — к параметрам, которые работают на ноде; previous запроса — только если они неизвестны. Иначе при двух правках
  // A→B и B→C, применённых одним разом, вторая вернула бы B, которого на ноде нет (#58)
  const baseline = ProvisionService.appliedBaselineOf(id);
  const restore = (k: string) => (baseline && k in baseline ? baseline[k] : previous[k]) ?? null;
  const rolledBack = transaction(() => {
    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as any;
    // Значения успели изменить ещё раз — откатывать чужую правку нельзя
    if (!row || keys.some((k) => !sameValue(row[k], written[k]))) return false;
    db.prepare(`UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(', ')}, needs_apply = 1 WHERE id = ?`).run(
      ...(keys.map(restore) as any[]),
      id
    );
    return true;
  });
  return rolledBack
    ? `Не удалось применить изменения на ноде: ${result.error}. Порт и параметры возвращены к прежним — клиенты продолжают работать.`
    : `Не удалось применить изменения на ноде: ${result.error}`;
}

function validateKey(value: unknown): string {
  if (typeof value !== 'string' || !value.includes('PRIVATE KEY')) {
    throw new HttpError(400, 'SSH-ключ должен быть в формате PEM/OpenSSH (-----BEGIN ... PRIVATE KEY-----)');
  }
  return value.trim() + '\n';
}

// GET all servers
serversRouter.get('/', (req, res) => {
  const servers = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id) as client_count,
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id AND enabled = 1) as active_client_count
    FROM servers s
    ORDER BY s.id DESC
  `).all();
  res.json(servers.map(serializeServer));
});

// GET single server
serversRouter.get('/:id', (req, res) => {
  const id = parseId(req.params.id);
  getServerOr404(id);
  res.json(serializeServer(selectServerWithCounts(id)));
});

// POST create server
serversRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  const name = validateName(body.name);
  if (!isValidHost(body.host)) throw new HttpError(400, 'Укажите корректный IP-адрес или домен сервера');
  const host = String(body.host).trim();
  const sshPort = validatePort(body.ssh_port ?? 22, 'SSH-порт');
  const sshUser = validateSshUser(body.ssh_user ?? 'root');
  const protocol = body.protocol === undefined ? 'awg' : body.protocol;
  if (!NODE_PROTOCOLS.includes(protocol)) throw new HttpError(400, 'Неизвестный протокол ноды');
  const awgPort = validateNodePort(body.awg_port ?? (protocol === 'vless' ? DEFAULT_VLESS_PORT : 51820), protocol);
  const subnet = protocol === 'vless' ? '' : validateSubnet(body.subnet ?? '10.8.0.1/24');
  const sshKey = body.ssh_key ? validateKey(body.ssh_key) : null;
  const sshPassword = typeof body.ssh_password === 'string' && body.ssh_password ? body.ssh_password : null;
  if (!sshKey && !sshPassword) throw new HttpError(400, 'Укажите SSH-пароль или приватный ключ');
  assertEndpointFree(host, awgPort, protocol);

  const id = insertServer({ name, host, sshPort, sshUser, sshPassword, sshKey, awgPort, subnet, protocol });
  EventService.log('info', 'server.created', `Добавлена нода «${name}»`, { kind: 'server', id });
  res.status(201).json(serializeServer(selectServerWithCounts(id)));
});

interface NewServer {
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  sshPassword: string | null;
  sshKey: string | null;
  awgPort: number;
  subnet: string;
  protocol?: NodeProtocol;
}

/**
 * Запись нового (ещё не установленного) сервера с ключами и параметрами актуальной версии AmneziaWG.
 * При подключении уже установленного AmneziaWG сканер заменит их фактическими значениями с ноды.
 */
function insertServer(s: NewServer): number {
  const protocol = s.protocol ?? 'awg';
  const keyPair = AwgService.generateKeyPair();
  const psk = protocol === 'vless' ? null : AwgService.generatePresharedKey();
  const columns = protocol === 'vless'
    ? { ...vlessParamsToColumns(generateVlessParams()), container_name: XRAY_CONTAINER, conf_path: XRAY_CONF_PATH }
    : paramsToColumns(AwgService.generateRandomParams());
  const result = db.prepare(`
    INSERT INTO servers (
      name, host, ssh_port, ssh_user, ssh_password, ssh_key,
      awg_port, subnet, server_public_key, server_private_key, preshared_key, protocol, status,
      ${Object.keys(columns).join(', ')}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uninstalled', ${Object.keys(columns).map(() => '?').join(', ')})
  `).run(
    s.name, s.host, s.sshPort, s.sshUser, encryptSecret(s.sshPassword), encryptSecret(s.sshKey),
    s.awgPort, s.subnet, keyPair.publicKey, keyPair.privateKey, psk, protocol,
    ...(Object.values(columns) as any[])
  );
  return Number(result.lastInsertRowid);
}

// POST /awg-signature — готовый сигнатурный пакет I1 по пресету (docs/awg-protocol.md); ничего не сохраняет
serversRouter.post('/awg-signature', (req, res) => {
  const preset = req.body?.preset as SignaturePreset;
  if (!SIGNATURE_PRESETS.includes(preset)) throw new HttpError(400, 'Неизвестный пресет сигнатурного пакета');
  const domain = normalizeSignatureDomain(req.body?.domain);
  if (preset !== 'stun' && !domain) throw new HttpError(400, 'Укажите домен, под обращение к которому маскируется пакет (например, example.com)');
  res.json({ preset, i1: generateSignature(preset, domain) });
});

const MAX_IMPORT_KEYS = 50;

/**
 * POST /import-amnezia { keys: "vpn://… vpn://…" } — перенос серверов из AmneziaVPN по ключам «полного доступа».
 * Для каждого ключа: SSH-доступ из ключа → новый сервер → сканирование → подключение работающего
 * AmneziaWG без переустановки (ключи, параметры, клиенты). Если AmneziaWG не найден, сервер остаётся
 * неустановленным, и его можно установить из панели.
 */
serversRouter.post('/import-amnezia', asyncHandler(async (req, res) => {
  if (req.body?.protocol === 'vless') throw new HttpError(400, 'Недоступно для VLESS');
  const keys = splitAmneziaKeys(String(req.body?.keys ?? ''));
  if (keys.length === 0) throw new HttpError(400, 'Вставьте один или несколько ключей AmneziaVPN (vpn://…)');
  if (keys.length > MAX_IMPORT_KEYS) throw new HttpError(400, `Не больше ${MAX_IMPORT_KEYS} ключей за раз`);

  const results: any[] = [];
  for (const [index, key] of keys.entries()) {
    const label = `Ключ ${index + 1}`;
    let access;
    try {
      access = decodeAmneziaKey(key);
    } catch (err: any) {
      results.push({ key: label, status: 'invalid', message: err instanceof AmneziaKeyError ? err.message : 'Не удалось прочитать ключ' });
      continue;
    }

    // Имя сервера не длиннее 64 символов, а доменное имя в ключе может быть до 253
    const name = (access.description || access.host).slice(0, 64);
    if (!isValidHost(access.host) || !isValidPort(access.port)) {
      results.push({ key: label, name, status: 'invalid', message: 'В ключе некорректный адрес или SSH-порт сервера' });
      continue;
    }
    const existing = db.prepare('SELECT id FROM servers WHERE host = ? AND remote_panel_id IS NULL').get(access.host) as any;
    if (existing) {
      results.push({ key: label, name, status: 'exists', serverId: existing.id, message: 'Сервер с этим адресом уже есть в панели' });
      continue;
    }

    let sshUser: string;
    try {
      sshUser = validateSshUser(access.username);
    } catch {
      results.push({ key: label, name, status: 'invalid', message: 'В ключе некорректное имя SSH-пользователя' });
      continue;
    }

    const id = insertServer({
      name: validateName(name),
      host: access.host,
      sshPort: access.port,
      sshUser,
      sshPassword: access.password,
      sshKey: access.privateKey,
      awgPort: 51820,
      subnet: '10.8.0.1/24',
    });

    try {
      const scan = await ProvisionService.scanAndAdopt(id);
      results.push({
        key: label,
        name,
        serverId: id,
        status: scan.found ? 'adopted' : 'needs_install',
        message: scan.found
          ? scan.message
          : `${scan.message}.${access.containers.length ? ` Протоколы в AmneziaVPN: ${access.containers.join(', ')}.` : ''}`,
        importedPeers: scan.adopted?.importedPeers ?? 0,
      });
    } catch (err: any) {
      db.prepare("UPDATE servers SET last_error = ? WHERE id = ?").run(err.message, id);
      results.push({ key: label, name, serverId: id, status: 'ssh_error', message: `Сервер добавлен, но подключиться по SSH не удалось: ${err.message}` });
    }
  }

  res.json({ results });
}));

// Страна — локальная метка карты, в том числе для нод партнёров.
serversRouter.put('/:id/country', (req, res) => {
  const id = parseId(req.params.id);
  const server = getServerOr404(id);
  const value: unknown = req.body?.country;
  const country = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (country !== null && (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country))) {
    throw new HttpError(400, 'Укажите двухбуквенный код страны или очистите поле');
  }
  if (server.country !== country) {
    db.prepare('UPDATE servers SET country = ? WHERE id = ?').run(country, id);
    EventService.log('info', 'server.updated', `Изменена страна ноды «${server.name}»`, { kind: 'server', id });
  }
  res.json(serializeServer(selectServerWithCounts(id)));
});

// PUT update server
serversRouter.put('/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const server = getLocalServerOr404(id);
  const body = req.body ?? {};
  const updates: Record<string, unknown> = {};
  const protocol = nodeProtocol(server);
  if (body.protocol !== undefined && body.protocol !== protocol) throw new HttpError(400, 'Нельзя изменить протокол ноды');
  if (protocol === 'vless') {
    // Подсеть у VLESS не используется: форма может прислать прежнее (пустое) значение — его просто не трогаем
    if (body.subnet !== undefined && body.subnet !== '' && body.subnet !== server.subnet) {
      throw new HttpError(400, 'Параметры AmneziaWG недоступны для VLESS');
    }
    delete body.subnet;
    if ([...INT_PARAM_KEYS, ...TEXT_PARAM_KEYS, 'awg_version', 'extra_params'].some((key) => body[key] !== undefined)) {
      throw new HttpError(400, 'Параметры AmneziaWG недоступны для VLESS');
    }
  }

  if (body.name !== undefined) updates.name = validateName(body.name);
  if (body.host !== undefined) {
    if (!isValidHost(body.host)) throw new HttpError(400, 'Укажите корректный IP-адрес или домен сервера');
    updates.host = String(body.host).trim();
    if (updates.host !== server.host) updates.host_key = null;
  }
  if (body.ssh_port !== undefined) updates.ssh_port = validatePort(body.ssh_port, 'SSH-порт');
  if (body.ssh_user !== undefined) updates.ssh_user = validateSshUser(body.ssh_user);

  // Аутентификация: auth_type переключает способ, старый секрет очищается
  if (body.auth_type === 'password') {
    if (!body.ssh_password) throw new HttpError(400, 'Укажите SSH-пароль');
    updates.ssh_password = encryptSecret(String(body.ssh_password));
    updates.ssh_key = null;
  } else if (body.auth_type === 'key') {
    updates.ssh_key = encryptSecret(validateKey(body.ssh_key));
    updates.ssh_password = null;
  }
  if (body.reset_host_key === true) updates.host_key = null;

  let interfaceChanged = false;
  if (body.awg_port !== undefined) {
    updates.awg_port = validateNodePort(body.awg_port, protocol);
    interfaceChanged ||= updates.awg_port !== server.awg_port;
  }
  // Форма редактирования присылает подсеть всегда; у импортированных нод она бывает адресом сети (10.8.1.0/24),
  // который строгая проверка не пропускает, — проверяется только изменённая подсеть
  if (body.subnet !== undefined && String(body.subnet).trim() !== server.subnet) {
    updates.subnet = validateSubnet(body.subnet);
    const count = (db.prepare('SELECT COUNT(*) as c FROM clients WHERE server_id = ?').get(id) as { c: number }).c;
    if (count > 0) throw new HttpError(400, 'Нельзя изменить подсеть, пока на сервере есть клиенты');
    interfaceChanged = true;
  }

  const current = paramsFromRow(server);
  const params: AwgParams = { ...current };
  let paramsTouched = false;
  for (const key of INT_PARAM_KEYS) {
    if (body[key] !== undefined) {
      const value = body[key] === null || body[key] === '' ? null : Number(body[key]);
      (params as any)[key] = key === 's3' || key === 's4' ? value : Number(value);
      paramsTouched = true;
    }
  }
  for (const key of TEXT_PARAM_KEYS) {
    if (body[key] !== undefined) {
      const value = body[key] === null ? '' : String(body[key]).trim();
      (params as any)[key] = key.startsWith('h') && key.length === 2 ? value : value || null;
      paramsTouched = true;
    }
  }
  if (paramsTouched) {
    const error = AwgService.validateParams(params);
    if (error) throw new HttpError(400, error);
    const before = paramsToColumns(current);
    const after = paramsToColumns(params);
    for (const [key, value] of Object.entries(after)) {
      if (value !== before[key]) {
        updates[key] = value;
        if (!CLIENT_ONLY_PARAM_KEYS.has(key)) interfaceChanged = true;
      }
    }
  }

  let paramColumns = paramsToColumns(current);
  if (protocol === 'vless') {
    const reality = vlessParamsFromRow(server);
    const before = vlessParamsToColumns(reality);
    const supplied = Object.keys(before).filter((key) => body[key] !== undefined);
    if (supplied.length) {
      const next = Object.assign(reality, Object.fromEntries(supplied.map((key) => [key, body[key]])));
      const error = validateVlessParams(next);
      if (error) throw new HttpError(400, error);
      for (const [key, value] of Object.entries(vlessParamsToColumns(next))) {
        if (value !== before[key]) {
          updates[key] = value;
          interfaceChanged = true;
        }
      }
    }
    paramColumns = before;
  }

  if (protocol === 'vless' && server.cdn_enabled && updates.awg_port !== undefined && Number(updates.awg_port) === Number(server.cdn_port)) {
    throw new HttpError(400, 'Этот порт занят входом через CDN — выберите другой');
  }

  // Уже существующие дубли не мешают правке других полей — проверяется только смена адреса или порта
  if (updates.host !== undefined || updates.awg_port !== undefined) {
    const host = String(updates.host ?? server.host);
    const awgPort = Number(updates.awg_port ?? server.awg_port);
    if (host.toLowerCase() !== String(server.host).toLowerCase() || awgPort !== server.awg_port) assertEndpointFree(host, awgPort, protocol, id);
  }

  const keys = Object.keys(updates);
  if (interfaceChanged) ProvisionService.noteAppliedBaseline(server);
  if (keys.length > 0) {
    db.prepare(`UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...(keys.map((k) => updates[k]) as any[]),
      id
    );
  }

  if (interfaceChanged && server.status !== 'uninstalled') {
    const interfaceKeys = Object.keys(updates).filter((k) => k === 'awg_port' || k === 'subnet' || k in paramColumns);
    const written = Object.fromEntries(interfaceKeys.map((k) => [k, updates[k]]));
    const previous = Object.fromEntries(interfaceKeys.map((k) => [k, server[k]]));
    const error = await applyOrRollback(id, previous, written);
    if (error) {
      return res.status(502).json({ success: false, error, server: serializeServer(selectServerWithCounts(id)) });
    }
  }

  EventService.log('info', 'server.updated', `Изменены настройки ноды «${updates.name ?? server.name}»`, { kind: 'server', id });
  res.json(serializeServer(selectServerWithCounts(id)));
}));

// DELETE server (?teardown=1 — остановить и удалить контейнер на ноде; ?force=1 — удалить из панели даже при ошибке)
serversRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const server = getLocalServerOr404(id);
  if (ProvisionService.isInstalling(id)) throw new HttpError(409, 'Дождитесь окончания установки');

  if (req.query.teardown === '1' && server.status !== 'uninstalled') {
    const result = await ProvisionService.teardown(id);
    if (!result.success && req.query.force !== '1') {
      throw new HttpError(
        502,
        `Не удалось остановить AmneziaWG на ноде: ${result.error}. VPN на сервере продолжит работать — удалите принудительно или остановите контейнер вручную.`
      );
    }
  }

  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  await CdnService.forget(server);
  EventService.log('info', 'server.deleted', `Удалена нода «${server.name}»`, { kind: 'server', id });
  res.json({ success: true, message: 'Сервер удален из панели' });
}));

// POST /:id/cdn { domain, port?, address?, origin_ip?, token?, email? } — вход через CDN Cloudflare для ноды VLESS
serversRouter.post('/:id/cdn', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  getLocalServerOr404(id);
  if (ProvisionService.isInstalling(id)) throw new HttpError(409, 'Дождитесь окончания установки');
  await CdnService.enable(id, req.body ?? {});
  res.json(serializeServer(selectServerWithCounts(id)));
}));

// DELETE /:id/cdn — выключить вход через CDN (A-запись в Cloudflare удаляется, сертификат сохраняется)
serversRouter.delete('/:id/cdn', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  getLocalServerOr404(id);
  const result = await CdnService.disable(id);
  res.json({ ...serializeServer(selectServerWithCounts(id)), ...(result.warning ? { warning: result.warning } : {}) });
}));

// POST test SSH connection
serversRouter.post('/:id/test-ssh', asyncHandler(async (req, res) => {
  const server = getLocalServerOr404(parseId(req.params.id));
  const result = await SshService.testConnection(ProvisionService.getCredentials(server));
  res.json(result);
}));

// POST randomize AWG parameters (and apply them on the node)
serversRouter.post('/:id/randomize-params', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const server = getLocalServerOr404(id);

  // Новые случайные значения в рамках текущей версии протокола; I1–I5 и доп. параметры сохраняются
  const current = paramsFromRow(server);
  // VLESS: новые SNI/shortId, транспорт и режим XHTTP сохраняются (их меняют только явно), путь — новый
  const currentVless = vlessParamsFromRow(server);
  const columns = nodeProtocol(server) === 'vless'
    ? vlessParamsToColumns({
      ...generateVlessParams(),
      xray_transport: currentVless.xray_transport,
      xhttp_mode: currentVless.xhttp_mode,
    })
    : paramsToColumns({
      ...AwgService.generateRandomParams(current.awg_version),
      i1: current.i1, i2: current.i2, i3: current.i3, i4: current.i4, i5: current.i5,
      extra_params: current.extra_params,
    });
  ProvisionService.noteAppliedBaseline(server);
  db.prepare(`UPDATE servers SET ${Object.keys(columns).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...(Object.values(columns) as any[]),
    id
  );

  if (server.status !== 'uninstalled') {
    const previous = Object.fromEntries(Object.keys(columns).map((k) => [k, server[k]]));
    const error = await applyOrRollback(id, previous, columns);
    if (error) {
      return res.status(502).json({ success: false, error, server: serializeServer(selectServerWithCounts(id)) });
    }
  }

  res.json(serializeServer(selectServerWithCounts(id)));
}));

// POST sync peers to server
serversRouter.post('/:id/sync', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  getServerOr404(id);
  const result = await ProvisionService.syncPeers(id);
  res.status(result.success ? 200 : 502).json(result);
}));

// POST apply interface parameters (restart AmneziaWG on the node)
serversRouter.post('/:id/apply', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  getLocalServerOr404(id);
  const result = await ProvisionService.requestApply(id);
  res.status(result.success ? 200 : 502).json(result);
}));

// POST scan — поиск уже установленного AmneziaWG (контейнера панели или приложения Amnezia) и подключение без установки
serversRouter.post('/:id/scan', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (nodeProtocol(getLocalServerOr404(id)) === 'vless') throw new HttpError(400, 'Недоступно для VLESS');
  if (ProvisionService.isInstalling(id)) throw new HttpError(409, 'Дождитесь окончания установки');
  try {
    const result = await ProvisionService.scanAndAdopt(id);
    res.json({ ...result, server: serializeServer(selectServerWithCounts(id)) });
  } catch (err: any) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, err.message);
  }
}));

// POST upgrade-protocol — переход на актуальную версию AmneziaWG: новые параметры и переустановка с latest-образом
serversRouter.post('/:id/upgrade-protocol', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const server = getLocalServerOr404(id);
  if (nodeProtocol(server) === 'vless') throw new HttpError(400, 'Недоступно для VLESS');
  const current = paramsFromRow(server);
  if (current.awg_version === LATEST_AWG_VERSION) throw new HttpError(400, 'Сервер уже использует актуальную версию протокола');

  const params: AwgParams = {
    ...AwgService.generateRandomParams(LATEST_AWG_VERSION),
    i1: current.i1, i2: current.i2, i3: current.i3, i4: current.i4, i5: current.i5,
    extra_params: current.extra_params,
  };
  const columns = paramsToColumns(params);
  ProvisionService.noteAppliedBaseline(server);
  db.prepare(`UPDATE servers SET ${Object.keys(columns).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...(Object.values(columns) as any[]),
    id
  );

  if (server.status === 'uninstalled') {
    return res.json({ success: true, server: serializeServer(selectServerWithCounts(id)) });
  }
  const result = await ProvisionService.requestReinstall(id);
  if (!result.success) {
    // Нода осталась на прежних параметрах — возвращаем их, чтобы подписки не раздавали несовместимые конфиги
    const previous = paramsToColumns(current);
    db.prepare(`UPDATE servers SET ${Object.keys(previous).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...(Object.values(previous) as any[]),
      id
    );
    result.error = `${result.error}. Параметры возвращены к прежним (AmneziaWG ${current.awg_version}.x).`;
  }
  res.status(result.success ? 200 : 502).json({ ...result, server: serializeServer(selectServerWithCounts(id)) });
}));
