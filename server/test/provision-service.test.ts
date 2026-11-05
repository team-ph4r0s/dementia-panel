import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase, setSetting } from '../src/db/index.js';
import { AwgService } from '../src/services/awg.service.js';
import { parseNodeInfo, parseScanOutput, ProvisionService } from '../src/services/provision.service.js';
import { HostKeyMismatchError } from '../src/services/ssh.service.js';
import { getServer, insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';

/**
 * ProvisionService без реального SSH: команды к ноде записываются заглушкой и проверяются.
 * Реальную ноду в Docker проверяют real-docker-*.test.ts.
 */

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Перед установкой панель сканирует сервер (защита чужого контейнера); это отдельный вызов SSH без скрипта развёртывания */
const isScan = (command: string) => command.includes('docker ps -a --format');
const deployed = (calls: { command: string; input?: string }[]) => calls.filter((c) => !isScan(c.command));

const dumpLine = (key: string, rx: number, tx: number) => `${key}\t(none)\t1.2.3.4:5\t10.8.0.2/32\t1700000000\t${rx}\t${tx}\toff`;

describe('синхронизация пиров (doSync)', () => {
  it('отправляет на ноду конфиг только с активными клиентами и сбрасывает needs_sync', async () => {
    const serverId = insertServer();
    const active = insertClient(serverId);
    const disabled = insertClient(serverId, { enabled: 0 });
    const suspended = insertSubscriber();
    db.prepare('UPDATE subscribers SET suspended = 1 WHERE id = ?').run(suspended);
    const ofSuspended = insertClient(serverId, { subscriberId: suspended });
    const ssh = stubSsh();

    const result = await ProvisionService.requestSync(serverId);

    expect(result).toEqual({ success: true });
    expect(ssh.calls).toHaveLength(1);
    const conf = ssh.calls[0].input!;
    expect(conf).toContain(active.publicKey);
    expect(conf).not.toContain(disabled.publicKey);
    expect(conf).not.toContain(ofSuspended.publicKey);
    expect(conf).toContain('[Interface]');
    expect(ssh.calls[0].command).toContain("docker exec -i 'amnezia-awg' sh -c");
    expect(ssh.calls[0].command).toContain('awg syncconf awg0');
    expect(ssh.calls[0].command).not.toContain('sudo');
    expect(getServer(serverId)).toMatchObject({ needs_sync: 0, last_error: null });
  });

  it('использует контейнер, интерфейс и утилиту сервера, а для не-root — sudo -n', async () => {
    const serverId = insertServer({
      managedBy: 'amnezia', containerName: 'amnezia-awg2', iface: 'wg0', confPath: '/opt/amnezia/awg/wg0.conf', awgTool: 'wg', sshUser: 'deploy',
    });
    const ssh = stubSsh();

    await ProvisionService.requestSync(serverId);

    const command = ssh.calls[0].command;
    expect(command).toContain("sudo -n docker exec -i 'amnezia-awg2' sh -c");
    expect(command).toContain('wg-quick strip /opt/amnezia/awg/wg0.conf');
    expect(command).toContain('wg syncconf wg0');
    expect(command).not.toContain('awg ');
  });

  it('при ошибке ноды оставляет needs_sync и сохраняет текст ошибки для повторной попытки', async () => {
    const serverId = insertServer();
    stubSsh(() => ({ code: 1, stderr: 'RTNETLINK answers: boom' }));

    const result = await ProvisionService.requestSync(serverId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('boom');
    expect(getServer(serverId)).toMatchObject({ needs_sync: 1 });
    expect(getServer(serverId).last_error).toContain('boom');
  });

  it('недоступная по SSH нода не роняет синхронизацию', async () => {
    const serverId = insertServer();
    stubSsh(() => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(await ProvisionService.requestSync(serverId)).toEqual({ success: false, error: 'connect ECONNREFUSED' });
    expect(getServer(serverId).needs_sync).toBe(1);
  });

  it('одновременные запросы объединяются в одну отправку', async () => {
    const serverId = insertServer();
    const ssh = stubSsh(() => new Promise((resolve) => setTimeout(() => resolve({}), 15)));

    await Promise.all([ProvisionService.requestSync(serverId), ProvisionService.requestSync(serverId), ProvisionService.requestSync(serverId)]);

    expect(ssh.calls).toHaveLength(1);
  });

  it('не трогает нераспознанные состояния: неустановленный сервер и несуществующий id', async () => {
    const uninstalled = insertServer({ status: 'uninstalled' });
    const ssh = stubSsh();
    expect(await ProvisionService.requestSync(uninstalled)).toEqual({ success: false, error: 'Сервер не установлен' });
    expect(await ProvisionService.requestSync(987654)).toEqual({ success: false, error: 'Сервер удалён' });
    expect(ssh.calls).toHaveLength(0);
  });

  it('при needs_apply синхронизация превращается в применение (перезапуск контейнера)', async () => {
    const serverId = insertServer({ managedBy: 'amnezia' });
    db.prepare('UPDATE servers SET needs_apply = 1 WHERE id = ?').run(serverId);
    const ssh = stubSsh();

    await ProvisionService.requestSync(serverId);

    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0].command).toContain("docker restart 'amnezia-awg'");
    expect(getServer(serverId)).toMatchObject({ needs_apply: 0, needs_sync: 0 });
  });
});

describe('применение параметров (doApply)', () => {
  it('для контейнера панели обновляет demension.env, затем конфиг и перезапускает контейнер', async () => {
    const serverId = insertServer({ subnet: '10.9.0.1/24', awgPort: 51830 });
    const ssh = stubSsh();

    const result = await ProvisionService.requestApply(serverId);

    expect(result.success).toBe(true);
    expect(ssh.calls).toHaveLength(2);
    expect(ssh.calls[0].input).toBe('AWG_NETWORK=10.9.0.0/24\nAWG_PORT=51830\n');
    expect(ssh.calls[0].command).toContain('demension.env');
    expect(ssh.calls[1].command).toContain("docker restart 'amnezia-awg'");
    expect(getServer(serverId)).toMatchObject({ needs_apply: 0, needs_sync: 0 });
  });

  it('при смене порта вместо перезапуска выполняется переустановка контейнера', async () => {
    const serverId = insertServer({ awgPort: 51840, deployedPort: 51820 });
    const ssh = stubSsh(() => ({ stdout: '---DEMENTIA_OK---\n' }));

    const result = await ProvisionService.requestApply(serverId);

    expect(result.success).toBe(true);
    expect(deployed(ssh.calls)).toHaveLength(1);
    expect(deployed(ssh.calls)[0].input).toContain("export AWG_PORT='51840'");
    expect(getServer(serverId)).toMatchObject({ deployed_port: 51840, status: 'online' });
  });

  it('ошибка перезапуска сохраняется, needs_apply остаётся для повтора', async () => {
    const serverId = insertServer({ managedBy: 'amnezia' });
    stubSsh(() => ({ code: 125, stderr: 'docker: daemon not running' }));

    const result = await ProvisionService.requestApply(serverId);

    expect(result.success).toBe(false);
    expect(getServer(serverId).needs_apply).toBe(1);
    expect(getServer(serverId).last_error).toContain('daemon not running');
  });

  it('нода партнёра управляется только владельцем', async () => {
    const panelId = Number(db.prepare("INSERT INTO remote_panels (name, base_url, token) VALUES ('p', 'https://p.example', 'x')").run().lastInsertRowid);
    const serverId = insertServer();
    db.prepare('UPDATE servers SET remote_panel_id = ?, remote_node_id = 1 WHERE id = ?').run(panelId, serverId);
    const ssh = stubSsh();

    expect((await ProvisionService.requestApply(serverId)).success).toBe(false);
    expect((await ProvisionService.requestReinstall(serverId)).success).toBe(false);
    await expect(ProvisionService.teardown(serverId)).rejects.toThrow('нода партнёра');
    await expect(ProvisionService.installServer(serverId)).rejects.toThrow('нода партнёра');
    expect(ssh.calls).toHaveLength(0);
  });
});

describe('установка (doInstall)', () => {
  it('передаёт скрипт через stdin с переменными окружения и фиксирует результат в БД', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null, awgPort: 51850, subnet: '10.7.0.1/24' });
    const client = insertClient(serverId, { ip: '10.7.0.2' });
    const logs: string[] = [];
    const ssh = stubSsh(() => ({ stdout: 'установка...\n---DEMENTIA_OK---\n' }));

    const result = await ProvisionService.installServer(serverId, (chunk) => logs.push(chunk));

    expect(result).toEqual({ success: true });
    const script = deployed(ssh.calls)[0].input!;
    expect(script).toContain("export AWG_PORT='51850'");
    expect(script).toContain("export AWG_NETWORK='10.7.0.0/24'");
    expect(script).toContain("export AWG_IMAGE='amneziavpn/amneziawg-go:latest'");
    expect(script).toContain("export REPLACE_CONTAINER=''");
    const encoded = /export AWG_CONF_B64='([^']+)'/.exec(script)![1];
    const conf = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(conf).toContain('ListenPort = 51850');
    expect(conf).toContain(client.publicKey);
    expect(deployed(ssh.calls)[0].command).toContain('PANEL_IP=');
    expect(logs.join('')).toContain('успешно установлен');
    expect(getServer(serverId)).toMatchObject({
      status: 'online', deployed_port: 51850, container_name: 'amnezia-awg', iface: 'awg0', awg_tool: 'awg', managed_by: 'demension', last_error: null,
    });
  });

  it('контейнер приложения Amnezia при установке заменяется контейнером панели', async () => {
    const serverId = insertServer({ managedBy: 'amnezia', containerName: 'amnezia-awg2', iface: 'wg0', awgTool: 'wg' });
    const ssh = stubSsh((call) =>
      isScan(call.command)
        ? { stdout: '---CONTAINER amnezia-awg2|amneziavpn/amnezia-awg:latest|true\n---CONF /opt/amnezia/awg/wg0.conf\n[Interface]\nListenPort = 51820\n---ENDCONF\n---TOOL wg' }
        : { stdout: '---DEMENTIA_OK---' }
    );

    expect((await ProvisionService.requestReinstall(serverId)).success).toBe(true);

    expect(deployed(ssh.calls)[0].input).toContain("export REPLACE_CONTAINER='amnezia-awg2'");
    expect(getServer(serverId)).toMatchObject({ container_name: 'amnezia-awg', iface: 'awg0', awg_tool: 'awg', managed_by: 'demension' });
  });

  it('без маркера успеха установка считается неудачной, статус error', async () => {
    const serverId = insertServer({ status: 'uninstalled' });
    stubSsh(() => ({ stdout: 'что-то пошло не так' }));

    const result = await ProvisionService.installServer(serverId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('не подтвердил');
    expect(getServer(serverId).status).toBe('error');
  });

  it('подсказывает про sudo без пароля, если у пользователя нет NOPASSWD', async () => {
    const serverId = insertServer({ status: 'uninstalled', sshUser: 'deploy' });
    stubSsh((call) => (isScan(call.command) ? {} : { code: 1, stderr: 'sudo: a password is required' }));

    const result = await ProvisionService.installServer(serverId);

    expect(result.error).toContain('NOPASSWD');
    expect(getServer(serverId).status).toBe('error');
  });

  it('вторая одновременная установка отклоняется', async () => {
    const serverId = insertServer({ status: 'uninstalled' });
    stubSsh(() => new Promise((resolve) => setTimeout(() => resolve({ stdout: '---DEMENTIA_OK---' }), 30)));

    const first = ProvisionService.installServer(serverId);
    expect(ProvisionService.isInstalling(serverId)).toBe(true);
    await expect(ProvisionService.installServer(serverId)).rejects.toThrow('уже выполняется');
    expect((await first).success).toBe(true);
    expect(ProvisionService.isInstalling(serverId)).toBe(false);
  });
});

describe('удаление контейнера (teardown)', () => {
  it('контейнер панели удаляется вместе с каталогом, чужой — только сам контейнер', async () => {
    const own = insertServer();
    const foreign = insertServer({ managedBy: 'amnezia', containerName: 'amnezia-awg2' });
    const ssh = stubSsh();

    expect((await ProvisionService.teardown(own)).success).toBe(true);
    expect((await ProvisionService.teardown(foreign)).success).toBe(true);

    expect(ssh.calls[0].command).toContain('docker rm -f amnezia-awg');
    expect(ssh.calls[0].command).toContain('rm -rf /opt/amnezia/awg');
    expect(ssh.calls[1].command).toContain('docker rm -f amnezia-awg2');
    expect(ssh.calls[1].command).not.toContain('rm -rf /opt/amnezia');
    // Заглушка проверки доступности — своя у панели, удаляется в обоих случаях
    for (const call of ssh.calls) {
      expect(call.command).toContain('docker rm -f dementia-probe');
      expect(call.command).toContain('rm -rf /opt/dementia-probe');
    }
  });
});

describe('версии ПО AmneziaWG на ноде', () => {
  const REAL_OUTPUT = [
    'IMAGE amneziavpn/amneziawg-go:latest',
    'CREATED 2026-08-28T15:50:06.566904559Z',
    'GO amneziawg-go 0.0.20250522',
    'TOOLS amneziawg-tools v3.1.20260812 - https://amnezia.org',
  ].join('\n');

  it('разбирает вывод образа amneziavpn/amneziawg-go', () => {
    expect(parseNodeInfo(REAL_OUTPUT)).toEqual({
      awg_go: '0.0.20250522',
      awg_tools: 'amneziawg-tools 3.1.20260812',
      image: 'amneziavpn/amneziawg-go:latest',
      image_created: '2026-08-28T15:50:06.566Z',
    });
  });

  it('контейнер без amneziawg-go (ядерный модуль, wireguard-tools) и пустой вывод', () => {
    expect(parseNodeInfo('IMAGE amnezia-awg\nCREATED \nGO \nTOOLS wireguard-tools v1.0.20210914 - https://git.zx2c4.com')).toEqual({
      awg_go: null,
      awg_tools: 'wireguard-tools 1.0.20210914',
      image: 'amnezia-awg',
      image_created: null,
    });
    expect(parseNodeInfo('')).toEqual({ awg_go: null, awg_tools: null, image: null, image_created: null });
  });

  it('значения с ноды проверяются по формату (они показываются в интерфейсе)', () => {
    const info = parseNodeInfo('IMAGE evil<img src=x>\nCREATED сегодня\nGO amneziawg-go 1.0<script>\nTOOLS awg $(reboot)');
    expect(info).toEqual({ awg_go: '1.0', awg_tools: null, image: null, image_created: null });
  });

  it('опрос ноды читает версии один раз и сохраняет их; повтор — после установки', async () => {
    const serverId = insertServer({ containerName: 'amnezia-awg2', managedBy: 'amnezia' });
    const ssh = stubSsh((call) => (call.command.includes('amneziawg-go --version') ? { stdout: REAL_OUTPUT } : { stdout: 'iface' }));

    await ProvisionService.fetchServerStats(serverId);
    await ProvisionService.fetchServerStats(serverId);

    const versionCalls = ssh.calls.filter((c) => c.command.includes('amneziawg-go --version'));
    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0].command).toContain("c='\\''amnezia-awg2'\\''");
    expect(getServer(serverId)).toMatchObject({
      node_awg_go: '0.0.20250522',
      node_awg_tools: 'amneziawg-tools 3.1.20260812',
      node_image: 'amneziavpn/amneziawg-go:latest',
      status: 'online',
    });
    expect(getServer(serverId).node_info_at).toBeTruthy();
  });

  it('ошибка чтения версий не влияет на статус ноды', async () => {
    const serverId = insertServer();
    stubSsh((call) => {
      if (call.command.includes('amneziawg-go --version')) throw new Error('connection reset');
      return { stdout: 'iface' };
    });

    await ProvisionService.fetchServerStats(serverId);

    expect(getServer(serverId)).toMatchObject({ status: 'online', fail_count: 0, last_error: null, node_info_at: null });
  });
});

describe('опрос ноды (fetchServerStats)', () => {
  it('накапливает трафик и переводит ноду в online', async () => {
    const serverId = insertServer({ status: 'offline' });
    const client = insertClient(serverId);
    db.prepare('UPDATE servers SET fail_count = 2 WHERE id = ?').run(serverId);
    const ssh = stubSsh((call) => (call.command.includes(' show ') ? { stdout: `iface\n${dumpLine(client.publicKey, 1000, 2000)}` } : {}));

    await ProvisionService.fetchServerStats(serverId);

    expect(ssh.calls[0].command).toContain("docker exec 'amnezia-awg' awg show awg0 dump");
    expect(getServer(serverId)).toMatchObject({ status: 'online', fail_count: 0 });
    expect(db.prepare('SELECT total_rx, total_tx FROM clients WHERE id = ?').get(client.id)).toEqual({ total_rx: 1000, total_tx: 2000 });
  });

  it('после трёх неудач подряд нода становится offline, успешный опрос возвращает online и запускает досинхронизацию', async () => {
    const serverId = insertServer();
    stubSsh(() => {
      throw new Error('timeout');
    });
    await ProvisionService.fetchServerStats(serverId);
    await ProvisionService.fetchServerStats(serverId);
    expect(getServer(serverId).status).toBe('online');
    await ProvisionService.fetchServerStats(serverId);
    expect(getServer(serverId)).toMatchObject({ status: 'offline', fail_count: 3, last_error: 'timeout' });

    vi.restoreAllMocks();
    const sync = vi.spyOn(ProvisionService, 'requestSync').mockResolvedValue({ success: true });
    stubSsh(() => ({ stdout: 'iface' }));
    await ProvisionService.fetchServerStats(serverId);
    expect(getServer(serverId)).toMatchObject({ status: 'online', fail_count: 0 });
    expect(sync).toHaveBeenCalledWith(serverId);
  });

  it('изменённый ключ SSH-хоста ставит статус error без накопления неудач', async () => {
    const serverId = insertServer({ hostKey: 'SHA256:old' });
    stubSsh(() => {
      throw new HostKeyMismatchError('SHA256:old', 'SHA256:new');
    });

    await ProvisionService.fetchServerStats(serverId);

    expect(getServer(serverId)).toMatchObject({ status: 'error', fail_count: 0 });
    expect(getServer(serverId).last_error).toContain('Ключ SSH-хоста изменился');
  });

  it('при ненулевом коде интерфейс считается недоступным', async () => {
    const serverId = insertServer();
    stubSsh(() => ({ code: 1, stderr: 'Unable to access interface' }));
    await ProvisionService.fetchServerStats(serverId);
    expect(getServer(serverId).last_error).toContain('Интерфейс awg0 недоступен');
    expect(getServer(serverId).fail_count).toBe(1);
  });

  it('при needs_apply опрос запускает применение, а не синхронизацию', async () => {
    const serverId = insertServer();
    db.prepare('UPDATE servers SET needs_apply = 1, needs_sync = 1 WHERE id = ?').run(serverId);
    stubSsh(() => ({ stdout: 'iface' }));
    const apply = vi.spyOn(ProvisionService, 'requestApply').mockResolvedValue({ success: true });
    const sync = vi.spyOn(ProvisionService, 'requestSync').mockResolvedValue({ success: true });

    await ProvisionService.fetchServerStats(serverId);

    expect(apply).toHaveBeenCalledWith(serverId);
    expect(sync).not.toHaveBeenCalled();
  });

  it('нода партнёра, неустановленный и устанавливаемый сервер не опрашиваются', async () => {
    const ssh = stubSsh();
    const uninstalled = insertServer({ status: 'uninstalled' });
    const installing = insertServer({ status: 'installing' });
    await ProvisionService.fetchServerStats(uninstalled);
    await ProvisionService.fetchServerStats(installing);
    await ProvisionService.fetchServerStats(424242);
    expect(ssh.calls).toHaveLength(0);
  });
});

describe('ключи SSH-хоста (TOFU)', () => {
  it('первый отпечаток сохраняется, следующий его не перезаписывает', () => {
    const serverId = insertServer();
    const credentials = ProvisionService.getCredentials(getServer(serverId));
    expect(credentials.hostKey).toBeNull();

    credentials.onNewHostKey!('SHA256:first');
    credentials.onNewHostKey!('SHA256:second');

    expect(getServer(serverId).host_key).toBe('SHA256:first');
    expect(ProvisionService.getCredentials(getServer(serverId)).hostKey).toBe('SHA256:first');
  });

  it('пароль расшифровывается перед подключением', () => {
    const serverId = insertServer({ sshPassword: 'p@ss' });
    expect(getServer(serverId).ssh_password).toMatch(/^enc:v1:/);
    expect(ProvisionService.getCredentials(getServer(serverId)).password).toBe('p@ss');
  });
});

describe('разбор вывода сканирования (parseScanOutput)', () => {
  const output = [
    '---CONTAINER amnezia-awg2|amneziavpn/amnezia-awg:latest|true',
    '---CONF /opt/amnezia/awg/wg0.conf',
    '[Interface]',
    'PrivateKey = KEY',
    '---ENDCONF',
    '---TOOL wg',
    '---CLIENTS',
    '[{"clientId":"PEER1=","userData":{"clientName":"Алиса"}},{"clientId":"PEER2=","userData":{}}]',
    '---ENDCLIENTS',
    '---CONTAINER amnezia-awg|amneziavpn/amneziawg-go|false',
  ].join('\n');

  it('различает контейнеры, утилиту, конфиг и имена клиентов', () => {
    const [foreign, stopped] = parseScanOutput(output);
    expect(foreign).toMatchObject({ name: 'amnezia-awg2', running: true, confPath: '/opt/amnezia/awg/wg0.conf', tool: 'wg', managedBy: 'amnezia' });
    expect(foreign.config).toBe('[Interface]\nPrivateKey = KEY');
    expect(foreign.clientNames).toEqual({ 'PEER1=': 'Алиса' });
    expect(stopped).toMatchObject({ name: 'amnezia-awg', running: false, config: null });
  });

  it('помечает контейнер панели маркером DEMENTIA и переживает мусор в clientsTable', () => {
    const [own] = parseScanOutput('---CONTAINER amnezia-awg|img|true\n---DEMENTIA\n---CLIENTS\nне json\n---ENDCLIENTS');
    expect(own.managedBy).toBe('demension');
    expect(own.clientNames).toEqual({});
  });

  it('пустой вывод — нет контейнеров', () => {
    expect(parseScanOutput('')).toEqual([]);
  });
});

describe('подключение установленного AmneziaWG (scanAndAdopt)', () => {
  const buildScan = (privateKey: string, peers: string, extra = '') =>
    [
      '---CONTAINER amnezia-awg2|amneziavpn/amnezia-awg:latest|true',
      '---CONF /opt/amnezia/awg/awg0.conf',
      '[Interface]',
      `PrivateKey = ${privateKey}`,
      'Address = 10.8.1.0/24',
      'ListenPort = 55555',
      'Jc = 5', 'Jmin = 10', 'Jmax = 50', 'S1 = 30', 'S2 = 40', 'H1 = 1111', 'H2 = 2222', 'H3 = 3333', 'H4 = 4444',
      extra,
      peers,
      '---ENDCONF',
      '---TOOL awg',
      '---CLIENTS',
      '[{"clientId":"PEERKEY1_______________________________________=","userData":{"clientName":"Алиса"}}]',
      '---ENDCLIENTS',
    ].join('\n');

  it('переносит ключи, порт, параметры и пиров (в том числе с AllowedIPs без /32)', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    const serverKeys = AwgService.generateKeyPair();
    const peers = [
      '[Peer]', 'PublicKey = PEERKEY1_______________________________________=', 'PresharedKey = PSKPSKPSK=', 'AllowedIPs = 10.8.1.2',
      '[Peer]', 'PublicKey = PEERKEY2=', 'AllowedIPs = 10.8.1.3/32',
      '[Peer]', 'PublicKey = PEERKEY3=', 'AllowedIPs = 10.8.1.3/32',
      '[Peer]', 'PublicKey = PEERKEY4=', 'AllowedIPs = 10.9.0.0/16',
    ].join('\n');
    stubSsh(() => ({ stdout: buildScan(serverKeys.privateKey, peers) }));

    const result = await ProvisionService.scanAndAdopt(serverId);

    expect(result.found).toBe(true);
    expect(result.adopted).toMatchObject({ container: 'amnezia-awg2', managedBy: 'amnezia', awgVersion: 1, port: 55555, importedPeers: 2, skippedPeers: 2 });
    expect(getServer(serverId)).toMatchObject({
      status: 'online', awg_port: 55555, deployed_port: 55555, subnet: '10.8.1.0/24', container_name: 'amnezia-awg2', iface: 'awg0',
      managed_by: 'amnezia', server_public_key: serverKeys.publicKey, jc: 5, s1: 30, h4: 4444, // колонка с INTEGER-аффинностью хранит одиночное число числом (paramsFromRow приводит к строке)
    });
    const imported = db.prepare('SELECT name, client_ip, external, enabled FROM clients WHERE server_id = ? ORDER BY client_ip').all(serverId);
    expect(imported).toEqual([
      { name: 'Алиса', client_ip: '10.8.1.2', external: 1, enabled: 1 },
      { name: 'Импорт 10.8.1.3', client_ip: '10.8.1.3', external: 1, enabled: 1 },
    ]);

    // Повторное сканирование не дублирует клиентов
    const again = await ProvisionService.scanAndAdopt(serverId);
    expect(again.adopted?.importedPeers).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM clients WHERE server_id = ?').get(serverId) as any).c).toBe(2);
  });

  it('если за время сканирования выдан архив переноса, результат не записывается (#59)', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    const before = getServer(serverId);
    const key = AwgService.generateKeyPair().privateKey;
    stubSsh(() => {
      // Пока ждали ответа SSH, панель перешла в exporting (архив уже собран)
      setSetting('migration_state', 'exporting');
      setSetting('migration_expires_at', new Date(Date.now() + 3600_000).toISOString());
      return { stdout: buildScan(key, '[Peer]\nPublicKey = PEERKEY9=\nAllowedIPs = 10.8.1.9/32') };
    });
    try {
      await expect(ProvisionService.scanAndAdopt(serverId)).rejects.toThrow('Идёт перенос панели');
      expect(getServer(serverId)).toMatchObject({ status: before.status, awg_port: before.awg_port, container_name: before.container_name });
      expect((db.prepare('SELECT COUNT(*) AS c FROM clients WHERE server_id = ?').get(serverId) as any).c).toBe(0);
    } finally {
      setSetting('migration_state', null);
      setSetting('migration_expires_at', null);
    }
  });

  it('сохраняет параметры AWG 3.x и дополнительные параметры как есть', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    const key = AwgService.generateKeyPair().privateKey;
    stubSsh(() => ({
      stdout: buildScan(key, '', ['S3 = 20', 'S4 = 16', 'H1 = 100-200', 'RekeyTimeout = 12', 'RandomTrailers = on'].join('\n')),
    }));

    const result = await ProvisionService.scanAndAdopt(serverId);

    expect(result.adopted?.awgVersion).toBe(3);
    const row = getServer(serverId);
    expect(row).toMatchObject({ awg_version: 3, s3: 20, s4: 16, h1: '100-200' });
    expect(JSON.parse(row.extra_params)).toEqual({ RekeyTimeout: '12', RandomTrailers: 'on' });
  });

  it('предпочитает контейнер панели чужому и сообщает, что ничего не найдено', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    stubSsh(() => ({ stdout: '' }));
    expect(await ProvisionService.scanAndAdopt(serverId)).toMatchObject({ found: false, message: expect.stringContaining('не найден') });

    vi.restoreAllMocks();
    stubSsh(() => ({ stdout: '---CONTAINER amnezia-awg|img|false' }));
    expect(await ProvisionService.scanAndAdopt(serverId)).toMatchObject({ found: false, message: expect.stringContaining('остановленные контейнеры') });
  });

  it('конфигурация без обязательных полей не подключается, сервер не меняется', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    stubSsh(() => ({ stdout: '---CONTAINER amnezia-awg|img|true\n---CONF /opt/amnezia/awg/awg0.conf\n[Interface]\nAddress = 10.8.0.1/24\n---ENDCONF' }));

    const result = await ProvisionService.scanAndAdopt(serverId);

    expect(result.found).toBe(false);
    expect(result.message).toContain('не удалось разобрать');
    expect(getServer(serverId).status).toBe('uninstalled');
  });

  it('ошибка sudo при сканировании объясняется пользователю', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    stubSsh(() => ({ code: 1, stderr: 'sudo: a terminal is required' }));
    await expect(ProvisionService.scanAndAdopt(serverId)).rejects.toThrow('нужен sudo без пароля');
  });
});

describe('защита чужого контейнера при установке', () => {
  const amneziaApp = (name: string, port: number, running = true) =>
    [
      `---CONTAINER ${name}|amneziavpn/amnezia-awg:latest|${running}`,
      ...(running ? ['---CONF /opt/amnezia/awg/wg0.conf', '[Interface]', 'PrivateKey = KEY', 'Address = 10.8.1.0/24', `ListenPort = ${port}`, '---ENDCONF', '---TOOL awg'] : []),
    ].join('\n');
  /** Заглушка узла: сканирование отдаёт `scan`, развёртывание успешно */
  const node = (scan: string) => stubSsh((call) => (isScan(call.command) ? { stdout: scan } : { stdout: '---DEMENTIA_OK---' }));

  it('контейнер приложения Amnezia с именем контейнера панели не удаляется: установка отказывается до любых изменений', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    const ssh = node(amneziaApp('amnezia-awg', 55424));
    const logs: string[] = [];

    const result = await ProvisionService.installServer(serverId, (chunk) => logs.push(chunk));

    expect(result.success).toBe(false);
    expect(result.error).toContain('AmneziaWG приложения Amnezia');
    expect(result.error).toContain('amnezia-awg');
    expect(result.error).toContain('Сканировать');
    expect(deployed(ssh.calls)).toHaveLength(0);
    expect(getServer(serverId)).toMatchObject({ status: 'uninstalled' });
    expect(logs.join('')).toContain('Установка удалила бы его');
  });

  it('то же для остановленного контейнера (его конфигурация тоже пропала бы)', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    const ssh = node(amneziaApp('amnezia-awg', 0, false));
    expect((await ProvisionService.installServer(serverId)).success).toBe(false);
    expect(deployed(ssh.calls)).toHaveLength(0);
  });

  it('другой контейнер Amnezia на том же UDP-порту тоже блокирует установку, на другом порту — нет', async () => {
    const clash = insertServer({ status: 'uninstalled', deployedPort: null, awgPort: 51820 });
    const clashSsh = node(amneziaApp('amnezia-awg2', 51820));
    expect((await ProvisionService.installServer(clash)).error).toContain('amnezia-awg2');
    expect(deployed(clashSsh.calls)).toHaveLength(0);
    vi.restoreAllMocks();

    const free = insertServer({ status: 'uninstalled', deployedPort: null, awgPort: 51821 });
    const freeSsh = node(amneziaApp('amnezia-awg2', 51820));
    expect((await ProvisionService.installServer(free)).success).toBe(true);
    expect(deployed(freeSsh.calls)).toHaveLength(1);
  });

  it('контейнер, уже подключённый к этому серверу, можно заменить (клиенты хранятся в БД панели)', async () => {
    const serverId = insertServer({ managedBy: 'amnezia', containerName: 'amnezia-awg', iface: 'wg0', awgPort: 55424 });
    const ssh = node(amneziaApp('amnezia-awg', 55424));

    expect((await ProvisionService.requestReinstall(serverId)).success).toBe(true);
    expect(deployed(ssh.calls)).toHaveLength(1);
    expect(getServer(serverId)).toMatchObject({ managed_by: 'demension', container_name: 'amnezia-awg' });
  });

  it('контейнер панели опознаётся по точному монтированию /opt/amnezia/awg, а не по подстроке пути (#60)', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    const ssh = node('');
    await ProvisionService.installServer(serverId);
    const scan = ssh.calls.find((call) => isScan(call.command))!.command.replace(/'\\''/g, "'");
    // Сравнивается источник монтирования с назначением ровно /opt/amnezia/awg — путь /opt/amnezia/awg-extra не подходит
    expect(scan).toContain('{{if eq .Destination "/opt/amnezia/awg"}}{{.Source}}{{end}}');
    expect(scan).toContain('[ "$mnt" = "/opt/amnezia/awg" ]');
    expect(scan).not.toMatch(/Mounts[^\n]*\|\s*grep -q/);
  });

  it('собственный контейнер панели переустанавливается без препятствий', async () => {
    const serverId = insertServer();
    const ssh = node('---CONTAINER amnezia-awg|amneziavpn/amneziawg-go:latest|true\n---DEMENTIA');
    expect((await ProvisionService.requestReinstall(serverId)).success).toBe(true);
    expect(deployed(ssh.calls)).toHaveLength(1);
  });

  it('если сервер нельзя проверить, установка не начинается: статус error, скрипт не отправляется', async () => {
    const serverId = insertServer({ status: 'uninstalled', deployedPort: null });
    const ssh = stubSsh((call) => {
      if (isScan(call.command)) return { code: 1, stderr: 'sudo: a password is required' };
      return { stdout: '---DEMENTIA_OK---' };
    });

    const result = await ProvisionService.installServer(serverId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('нужен sudo без пароля');
    expect(getServer(serverId).status).toBe('error');
    expect(deployed(ssh.calls)).toHaveLength(0);
  });
});
