import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { XrayService } from '../src/services/xray.service.js';
import { parseNodeInfo, parseXrayStats, ProvisionService } from '../src/services/provision.service.js';
import { XRAY_CONF_DIR, XRAY_CONF_PATH, XRAY_CONTAINER } from '../src/utils/vless-params.js';
import { getServer, insertServer, insertSubscriber } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function insertVlessServer(overrides: Partial<any> = {}): number {
  const id = insertServer({
    status: overrides.status ?? 'online',
    awgPort: overrides.port ?? 443,
    deployedPort: overrides.deployedPort !== undefined ? overrides.deployedPort : (overrides.port ?? 443),
  });
  db.prepare(`
    UPDATE servers
    SET protocol = 'vless',
        container_name = ?,
        conf_path = ?,
        managed_by = 'demension',
        awg_tool = 'xray'
    WHERE id = ?
  `).run(
    overrides.containerName ?? XRAY_CONTAINER,
    overrides.confPath ?? XRAY_CONF_PATH,
    id
  );
  if (overrides.realitySni) {
    db.prepare(`
      UPDATE servers
      SET reality_sni = ?,
          reality_dest = ?,
          reality_short_ids = ?,
          xray_flow = ?,
          xray_fingerprint = ?
      WHERE id = ?
    `).run(
      overrides.realitySni,
      overrides.realityDest ?? `${overrides.realitySni}:443`,
      JSON.stringify(overrides.realityShortIds ?? ['0123456789abcdef']),
      overrides.xrayFlow ?? 'xtls-rprx-vision',
      overrides.xrayFingerprint ?? 'chrome',
      id
    );
  }
  return id;
}

function insertVlessClient(serverId: number, overrides: Partial<any> = {}): { id: number; uuid: string } {
  const uuid = overrides.uuid ?? crypto.randomUUID();
  const result = db.prepare(`
    INSERT INTO clients (server_id, subscriber_id, name, client_ip, client_public_key, client_private_key, client_uuid, enabled)
    VALUES (?, ?, ?, '', '', '', ?, ?)
  `).run(
    serverId,
    overrides.subscriberId ?? null,
    overrides.name ?? 'test-vless-client',
    uuid,
    overrides.enabled ?? 1
  );
  return { id: Number(result.lastInsertRowid), uuid };
}

describe('parseXrayStats (чистая функция)', () => {
  it('разбирает корректный JSON от statsquery (объект stat)', () => {
    const jsonOutput = JSON.stringify({
      stat: [
        { name: 'user>>>c1>>>traffic>>>uplink', value: 1000 },
        { name: 'user>>>c1>>>traffic>>>downlink', value: 5000 },
        { name: 'user>>>c2>>>traffic>>>uplink', value: '250' },
        { name: 'user>>>c2>>>traffic>>>downlink', value: '750' },
      ],
    });

    const stats = parseXrayStats(jsonOutput);
    expect(stats).toHaveLength(2);

    const c1 = stats.find((s) => s.email === 'c1');
    expect(c1).toBeDefined();
    expect(c1?.uplink).toBe(1000);
    expect(c1?.downlink).toBe(5000);

    const c2 = stats.find((s) => s.email === 'c2');
    expect(c2).toBeDefined();
    expect(c2?.uplink).toBe(250);
    expect(c2?.downlink).toBe(750);
  });

  it('разбирает JSON с UUID в email', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const jsonOutput = JSON.stringify({
      stat: [
        { name: `user>>>${uuid}>>>traffic>>>uplink`, value: 300 },
        { name: `user>>>${uuid}>>>traffic>>>downlink`, value: 400 },
      ],
    });

    const stats = parseXrayStats(jsonOutput);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({
      email: uuid,
      uplink: 300,
      downlink: 400,
    });
  });

  it('разбирает вывод в текстовом формате при отсутствии JSON (fallback regex)', () => {
    const textOutput = `
      user>>>c10>>>traffic>>>uplink: 1024
      user>>>c10>>>traffic>>>downlink: 2048
      user>>>c20>>>traffic>>>uplink: 512
    `;

    const stats = parseXrayStats(textOutput);
    expect(stats).toHaveLength(2);

    const c10 = stats.find((s) => s.email === 'c10');
    expect(c10).toEqual({ email: 'c10', uplink: 1024, downlink: 2048 });

    const c20 = stats.find((s) => s.email === 'c20');
    expect(c20).toEqual({ email: 'c20', uplink: 512, downlink: 0 });
  });

  it('игнорирует недоверенные или повреждённые данные (инъекции, отрицательные байты, мусор)', () => {
    const malicious = JSON.stringify({
      stat: [
        { name: "user>>>c1'; DROP TABLE clients;-->>>traffic>>>uplink", value: 100 },
        { name: 'user>>>c2>>>traffic>>>uplink', value: -500 },
        { name: 'user>>>c2>>>traffic>>>downlink', value: 'not-a-number' },
        { name: 'inbound>>>api>>>traffic>>>uplink', value: 99999 },
        { name: 'user>>>c3>>>traffic>>>uplink', value: 777 },
      ],
    });

    const stats = parseXrayStats(malicious);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({ email: 'c3', uplink: 777, downlink: 0 });

    expect(parseXrayStats('')).toEqual([]);
    expect(parseXrayStats(null as any)).toEqual([]);
    expect(parseXrayStats('{ broken json')).toEqual([]);
  });
});

describe('установка VLESS-ноды (installServer)', () => {
  it('проверяет TCP-порт до установки: если занят — прерывает без изменения статуса', async () => {
    const serverId = insertVlessServer({ status: 'uninstalled', port: 443 });
    const ssh = stubSsh((call) => {
      if (call.command.includes('listening=')) {
        return { stdout: 'PORT_IN_USE\n' };
      }
      return {};
    });

    const res = await ProvisionService.installServer(serverId);
    expect(res.success).toBe(false);
    expect(res.error).toContain('TCP-порт 443 уже занят');
    // Команда развёртывания не вызывалась
    expect(ssh.calls.some((c) => c.command.includes('deploy-xray'))).toBe(false);
    // Статус остался uninstalled (не перешёл в installing/online)
    expect(getServer(serverId).status).toBe('uninstalled');
  });

  it('обнаруживает чужой контейнер dementia-xray и отклоняет установку', async () => {
    const serverId = insertVlessServer({ status: 'uninstalled', port: 443 });
    stubSsh((call) => {
      if (call.command.includes('FOREIGN_CONTAINER')) {
        return { stdout: 'FOREIGN_CONTAINER\n' };
      }
      return {};
    });

    const res = await ProvisionService.installServer(serverId);
    expect(res.success).toBe(false);
    expect(res.error).toContain('уже существует контейнер dementia-xray');
    expect(getServer(serverId).status).toBe('uninstalled');
  });

  it('успешно устанавливает Xray, передаёт deploy-xray.sh через stdin и сохраняет параметры Reality', async () => {
    const serverId = insertVlessServer({ status: 'uninstalled', port: 443 });
    vi.spyOn(XrayService, 'generateServerConfig').mockReturnValue('{"mock":"xray-config"}');

    const ssh = stubSsh((call) => {
      if (call.command.includes('listening=')) {
        return { stdout: 'OK\n' };
      }
      if (call.command.includes('deploy-xray')) {
        return { stdout: 'All good\n---DEMENTIA_OK---\n' };
      }
      return {};
    });

    const res = await ProvisionService.installServer(serverId);
    expect(res.success).toBe(true);

    const deployCall = ssh.calls.find((c) => c.command.includes('deploy-xray'));
    expect(deployCall).toBeDefined();
    expect(deployCall?.input).toContain("export VLESS_PORT='443'");
    expect(deployCall?.input).toContain("export XRAY_CONTAINER='dementia-xray'");
    expect(deployCall?.input).toContain("export XRAY_CONF_DIR='/opt/dementia-xray'");
    expect(deployCall?.input).toContain('export XRAY_IMAGE=');
    expect(deployCall?.input).toContain('export XRAY_CONF_B64=');

    const s = getServer(serverId);
    expect(s.status).toBe('online');
    expect(s.deployed_port).toBe(443);
    expect(s.container_name).toBe('dementia-xray');
    expect(s.conf_path).toBe('/opt/dementia-xray/config.json');
    expect(s.server_public_key).toBeTruthy();
    expect(s.server_private_key).toBeTruthy();
    expect(s.reality_sni).toBeTruthy();
    expect(s.reality_dest).toBeTruthy();
    expect(JSON.parse(s.reality_short_ids).length).toBeGreaterThan(0);
    expect(s.xray_flow).toBe('xtls-rprx-vision');
  });
});

describe('синхронизация VLESS-ноды (doSync)', () => {
  it('перезаписывает config.json и перезапускает контейнер dementia-xray', async () => {
    const serverId = insertVlessServer({ status: 'online', port: 443 });
    insertVlessClient(serverId, { name: 'client-1' });
    vi.spyOn(XrayService, 'generateServerConfig').mockReturnValue('{"inbounds":[{"tag":"vless"}]}');

    const ssh = stubSsh();
    const res = await ProvisionService.syncPeers(serverId);

    expect(res.success).toBe(true);
    expect(ssh.calls).toHaveLength(1);

    const call = ssh.calls[0];
    expect(call.input).toBe('{"inbounds":[{"tag":"vless"}]}');
    expect(call.command).toContain('chmod 600 /opt/dementia-xray/config.new.json');
    expect(call.command).toContain('mv -f /opt/dementia-xray/config.new.json /opt/dementia-xray/config.json');
    expect(call.command).toContain("docker restart 'dementia-xray'");
    // Конфиг проверяется Xray до замены и до перезапуска (иначе непринятый конфиг роняет ноду)
    const test = call.command.indexOf('run -test -c /etc/xray/config.new.json');
    expect(test).toBeGreaterThan(-1);
    expect(test).toBeLessThan(call.command.indexOf('mv -f /opt/dementia-xray/config.new.json'));
    expect(call.command.indexOf('mv -f')).toBeLessThan(call.command.indexOf('docker restart'));
    // Не должен использовать awg syncconf
    expect(call.command).not.toContain('syncconf');
    expect(getServer(serverId).needs_sync).toBe(0);
  });

  it('если Xray отклонил конфиг, контейнер не перезапускается, а ошибка сохраняется', async () => {
    const serverId = insertVlessServer({ status: 'online', port: 443 });
    insertVlessClient(serverId, { name: 'client-1' });
    db.prepare('UPDATE servers SET needs_sync = 1 WHERE id = ?').run(serverId);

    // Отказ проверки так, как его вернул бы ssh: скрипт записи завершился кодом 1, restart в цепочке `&&` не выполнен
    const ssh = stubSsh(() => ({ code: 1, stderr: 'Xray отклонил конфигурацию, работающий контейнер не тронут' }));
    const res = await ProvisionService.syncPeers(serverId);

    expect(res.success).toBe(false);
    expect(res.error).toContain('Xray отклонил конфигурацию');
    const command = ssh.calls[0].command;
    // Проверка и замена конфига — внутри одного sh -c, перезапуск — после него через `&&`
    expect(command).toMatch(/run -test -c \/etc\/xray\/config\.new\.json[\s\S]*exit 1[\s\S]*mv -f[\s\S]*' && (sudo )?docker restart/);
    expect(getServer(serverId).needs_sync).toBe(1);
  });
});

describe('применение параметров VLESS-ноды (doApply)', () => {
  it('применяет изменённые параметры Reality через docker restart', async () => {
    const serverId = insertVlessServer({ status: 'online', port: 443 });
    db.prepare("UPDATE servers SET needs_apply = 1, reality_sni = 'updated.domain.com' WHERE id = ?").run(serverId);
    vi.spyOn(XrayService, 'generateServerConfig').mockReturnValue('{"sni":"updated.domain.com"}');

    const ssh = stubSsh();
    const res = await ProvisionService.requestApply(serverId);

    expect(res.success).toBe(true);
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0].command).toContain("docker restart 'dementia-xray'");
    expect(getServer(serverId).needs_apply).toBe(0);
  });

  it('при смене порта запускает переустановку ноды', async () => {
    const serverId = insertVlessServer({ status: 'online', port: 8443, deployedPort: 443 });
    db.prepare('UPDATE servers SET needs_apply = 1 WHERE id = ?').run(serverId);
    vi.spyOn(XrayService, 'generateServerConfig').mockReturnValue('{"port":8443}');

    const ssh = stubSsh((call) => {
      if (call.command.includes('listening=')) return { stdout: 'OK\n' };
      if (call.command.includes('deploy-xray')) return { stdout: '---DEMENTIA_OK---\n' };
      return {};
    });

    const res = await ProvisionService.requestApply(serverId);
    expect(res.success).toBe(true);

    const deployCall = ssh.calls.find((c) => c.command.includes('deploy-xray'));
    expect(deployCall).toBeDefined();
    expect(deployCall?.input).toContain("export VLESS_PORT='8443'");
    expect(getServer(serverId).deployed_port).toBe(8443);
  });
});

describe('сбор статистики трафика (fetchServerStats / applyXrayStats)', () => {
  it('запрашивает statsquery -reset у Xray и накапливает total_rx/total_tx', async () => {
    const serverId = insertVlessServer({ status: 'online' });
    const c1 = insertVlessClient(serverId, { name: 'c1' });
    const c2 = insertVlessClient(serverId, { name: 'c2' });

    const statsPayload = JSON.stringify({
      stat: [
        { name: `user>>>c${c1.id}>>>traffic>>>uplink`, value: 1500 },
        { name: `user>>>c${c1.id}>>>traffic>>>downlink`, value: 3500 },
        { name: `user>>>c${c2.id}>>>traffic>>>uplink`, value: 0 },
        { name: `user>>>c${c2.id}>>>traffic>>>downlink`, value: 0 },
      ],
    });

    stubSsh((call) => {
      if (call.command.includes('statsquery')) {
        return { stdout: statsPayload };
      }
      return {};
    });

    await ProvisionService.fetchServerStats(serverId);

    const client1 = db.prepare('SELECT total_rx, total_tx, last_handshake FROM clients WHERE id = ?').get(c1.id) as any;
    expect(client1.total_rx).toBe(1500);
    expect(client1.total_tx).toBe(3500);
    expect(client1.last_handshake).toBeTruthy();

    const client2 = db.prepare('SELECT total_rx, total_tx, last_handshake FROM clients WHERE id = ?').get(c2.id) as any;
    expect(client2.total_rx).toBe(0);
    expect(client2.total_tx).toBe(0);
    expect(client2.last_handshake).toBeNull();
  });

  it('корректно прибавляет дельты трафика при повторных опросах', async () => {
    const serverId = insertVlessServer({ status: 'online' });
    const c = insertVlessClient(serverId);

    ProvisionService.applyXrayStats(
      serverId,
      JSON.stringify({
        stat: [
          { name: `user>>>c${c.id}>>>traffic>>>uplink`, value: 100 },
          { name: `user>>>c${c.id}>>>traffic>>>downlink`, value: 200 },
        ],
      })
    );

    let row = db.prepare('SELECT total_rx, total_tx FROM clients WHERE id = ?').get(c.id) as any;
    expect(row.total_rx).toBe(100);
    expect(row.total_tx).toBe(200);

    // Второй сброс (дельта 50 и 70)
    ProvisionService.applyXrayStats(
      serverId,
      JSON.stringify({
        stat: [
          { name: `user>>>c${c.id}>>>traffic>>>uplink`, value: 50 },
          { name: `user>>>c${c.id}>>>traffic>>>downlink`, value: 70 },
        ],
      })
    );

    row = db.prepare('SELECT total_rx, total_tx FROM clients WHERE id = ?').get(c.id) as any;
    expect(row.total_rx).toBe(150);
    expect(row.total_tx).toBe(270);
  });
});

describe('удаление ноды (teardown)', () => {
  it('для VLESS-ноды удаляет только контейнер dementia-xray и каталог /opt/dementia-xray', async () => {
    const serverId = insertVlessServer({ status: 'online' });
    const ssh = stubSsh();

    const res = await ProvisionService.teardown(serverId);
    expect(res.success).toBe(true);
    expect(ssh.calls).toHaveLength(1);

    const cmd = ssh.calls[0].command;
    // Команда целиком обёрнута в shellQuote, поэтому внутренние кавычки экранированы как '\''
    expect(cmd).toContain(String.raw`docker rm -f '\''dementia-xray'\''`);
    expect(cmd).toContain('/opt/dementia-xray/dementia.env');
    expect(cmd).toContain(String.raw`rm -rf '\''/opt/dementia-xray'\''`);
    expect(cmd).not.toContain('amnezia');
    // Ни в коем случае не трогать amnezia-* или /opt/amnezia
    expect(cmd).not.toContain('amnezia');
    expect(cmd).not.toContain('dementia-probe');
  });

  it.skipIf(process.platform === 'win32')('чужой dementia-xray без метки панели не удаляется (команда выполняется оболочкой)', async () => {
    const serverId = insertVlessServer({ status: 'online' });
    const ssh = stubSsh();
    await ProvisionService.teardown(serverId);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-teardown-'));
    const bin = path.join(tmp, 'bin');
    const dir = path.join(tmp, 'opt');
    fs.mkdirSync(bin);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "docker $*" >> "$LOG"\n', { mode: 0o755 });
    const command = ssh.calls[0].command.replaceAll(XRAY_CONF_DIR, dir).replace(/^sudo /, '');
    const run = () => {
      const log = path.join(tmp, 'log');
      fs.rmSync(log, { force: true });
      execFileSync('bash', ['-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log } });
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
    };
    try {
      expect(run()).toBe('');
      expect(fs.existsSync(dir)).toBe(true);
      fs.writeFileSync(path.join(dir, 'dementia.env'), 'VLESS_PORT=443\n');
      expect(run()).toContain(`docker rm -f ${XRAY_CONTAINER}`);
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('для AWG-ноды по-прежнему выполняет очистку amnezia', async () => {
    const serverId = insertServer({ managedBy: 'demension', containerName: 'amnezia-awg' });
    const ssh = stubSsh();

    const res = await ProvisionService.teardown(serverId);
    expect(res.success).toBe(true);

    const cmd = ssh.calls[0].command;
    expect(cmd).toContain('docker rm -f amnezia-awg');
    expect(cmd).toContain('/opt/amnezia/awg');
    expect(cmd).toContain('dementia-probe');
  });
});

describe('заглушки проверок доступности (probes)', () => {
  it('ensureProbeStub и readProbeHits бросают ошибку для VLESS-нод', async () => {
    const serverId = insertVlessServer({ status: 'online' });

    await expect(ProvisionService.ensureProbeStub(serverId)).rejects.toThrow(
      'Проверки доступности не поддерживаются для VLESS-нод'
    );

    await expect(ProvisionService.readProbeHits(serverId)).rejects.toThrow(
      'Проверки доступности не поддерживаются для VLESS-нод'
    );
  });
});

describe('сбор информации о ноде (fetchNodeInfo)', () => {
  it('для VLESS-ноды запрашивает xray version и обновляет запись в БД', async () => {
    const serverId = insertVlessServer({ status: 'online' });
    stubSsh((call) => {
      if (call.command.includes('xray version')) {
        return {
          stdout: [
            'IMAGE teddysun/xray:latest',
            'CREATED 2026-03-01T12:00:00Z',
            'XRAY Xray 1.8.24 (Xray, Penetrates Everything.) Custom (go1.22.0 linux/amd64)',
          ].join('\n'),
        };
      }
      return {};
    });

    const server = getServer(serverId);
    await ProvisionService.fetchNodeInfo(server);

    const updated = getServer(serverId);
    expect(updated.node_awg_tools).toBe('Xray 1.8.24');
    expect(updated.node_image).toBe('teddysun/xray:latest');
    expect(updated.node_image_created).toBe('2026-03-01T12:00:00.000Z');
  });
});

describe('deploy-xray.sh', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../src/scripts/deploy-xray.sh'), 'utf-8');

  it('чужой контейнер проверяется до записи метки и конфига, конфиг проверяется Xray до замены контейнера', () => {
    const foreignCheck = script.indexOf('метки панели');
    expect(foreignCheck).toBeGreaterThan(0);
    expect(foreignCheck).toBeLessThan(script.indexOf('dementia.env.new'));
    expect(foreignCheck).toBeLessThan(script.indexOf('config.new.json'));
    expect(script.indexOf('run -test -c /etc/xray/config.new.json')).toBeLessThan(script.indexOf('docker rm -f "$CONTAINER_NAME"'));
  });

  it('проверяемый конфиг имеет расширение .json: формат Xray определяет по расширению (config.json.new отвергался)', () => {
    const tested = [...script.matchAll(/run -test -c ([^\s;]+)/g)].map((m) => m[1]);
    expect(tested.length).toBeGreaterThan(0);
    for (const file of tested) expect(file).toMatch(/\.json$/);
  });

  it('образ distroless запускается от root (конфиг 600, порт 443) и не трогает AmneziaWG', () => {
    expect(script).toMatch(/docker run -d[\s\S]*--user 0:0/);
    expect(script).not.toMatch(/\/opt\/amnezia|docker rm[^\n]*amnezia/);
  });
});

describe('команды на VLESS-ноде без оболочки в контейнере', () => {
  it('версия Xray и статистика вызывают бинарник напрямую', async () => {
    const serverId = insertVlessServer({ status: 'online' });
    const ssh = stubSsh(() => ({ stdout: 'XRAY Xray 25.1.1 (Xray, Penetrates Everything.)\n' }));
    await ProvisionService.fetchNodeInfo(getServer(serverId));
    await ProvisionService.fetchServerStats(serverId);
    const commands = ssh.calls.map((call) => call.command).join('\n');
    expect(commands).toContain('/usr/local/bin/xray version');
    expect(commands).toContain('/usr/local/bin/xray api statsquery');
    expect(commands).not.toMatch(/exec [^\n]*sh -c[^\n]*xray/);
  });
});
