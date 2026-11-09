import { db } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { shellQuote } from '../utils/net.js';
import {
  buildPortRules, extraPortsRemoveScript, healthScript, installScript, MAX_EXTRA_PORTS, parseExtraPorts, parsePortsHealth, sha256,
} from '../utils/extra-ports.js';
import { nodeProtocol } from '../utils/vless-params.js';
import { MigrationService } from './migration.service.js';
import { ProvisionService, runExclusive } from './provision.service.js';
import { SshService } from './ssh.service.js';

/**
 * Запасные порты ноды AmneziaWG (docs/node-management.md#extra-ports).
 *
 * Блокировка часто ставится на пару «адрес:порт», а смена основного порта требует пересоздания контейнера и рвёт всех
 * клиентов (инвариант 12). Запасной порт — правило DNAT на хосте ноды: UDP `нода:запасной` → `контейнер:awg_port`.
 * AmneziaWG и его конфигурация не меняются, ключи и параметры обфускации те же; в подписке запасной порт — отдельная
 * запись с другим Endpoint.
 *
 * Правила генерируются целиком из БД (`buildPortRules`), применяются через очередь ноды и сверяются по SHA-256
 * (`servers.extra_ports_hash`), как правила моста. Адрес контейнера определяется на ноде при каждом применении:
 * после перезапуска Docker он может измениться, поэтому фоновая проверка сравнивает его с адресом в правилах.
 */

const HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const lastHealth = new Map<number, number>();
/** Время последней неудачной попытки применения: повтор не чаще раза в HEALTH_INTERVAL_MS */
const lastFailure = new Map<number, number>();

/** Проверка списка от администратора; бросает HttpError(400) */
export function validateExtraPorts(input: unknown, server: any): number[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'Запасные порты: ожидается список чисел');
  const ports: number[] = [];
  for (const raw of input) {
    const port = typeof raw === 'string' && /^\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Запасной порт — целое число от 1 до 65535');
    if (!ports.includes(port)) ports.push(port);
  }
  if (ports.length > MAX_EXTRA_PORTS) throw new HttpError(400, `Запасных портов не больше ${MAX_EXTRA_PORTS}`);
  for (const port of ports) {
    if (port === Number(server.awg_port)) throw new HttpError(400, `Порт ${port} — основной порт ноды`);
    // Заглушка проверки доступности слушает свой порт и по UDP
    if (port === Number(server.stub_port)) throw new HttpError(400, `Порт ${port} занят заглушкой проверки доступности`);
    const other = db.prepare(`
      SELECT name FROM servers
      WHERE id != ? AND remote_panel_id IS NULL AND lower(host) = lower(?) AND COALESCE(protocol, 'awg') != 'vless' AND awg_port = ?
    `).get(server.id, server.host, port) as { name: string } | undefined;
    if (other) throw new HttpError(400, `Порт ${port} — основной порт ноды «${other.name}» на этом же сервере`);
  }
  return ports;
}

/** Нода, на которой панель может держать запасные порты: своя, AmneziaWG, установленная */
function eligible(server: any): boolean {
  return Boolean(server) && !server.remote_panel_id && nodeProtocol(server) === 'awg'
    && server.status !== 'uninstalled' && server.status !== 'installing' && Boolean(server.container_name);
}

function rulesOf(server: any): string {
  return buildPortRules(String(server.container_name), Number(server.deployed_port ?? server.awg_port), parseExtraPorts(server.extra_ports));
}

export class ExtraPortsService {
  /**
   * Порты, которые сейчас действительно пересылаются на ноде: правила применены для текущих порта и списка.
   * Только их можно выдавать в подписке — подписка не должна раздавать то, чего нет на ноде (инвариант 28).
   */
  static activePorts(server: any): number[] {
    const ports = parseExtraPorts(server?.extra_ports);
    if (!ports.length || !server.extra_ports_hash || !server.container_name) return [];
    if (nodeProtocol(server) !== 'awg' || server.remote_panel_id) return [];
    if (server.deployed_port !== undefined && server.deployed_port !== null && Number(server.deployed_port) !== Number(server.awg_port)) return [];
    try {
      return sha256(buildPortRules(String(server.container_name), Number(server.awg_port), ports)) === server.extra_ports_hash ? ports : [];
    } catch {
      return [];
    }
  }

  /** Применить правила на ноде (через очередь ноды). Пустой список снимает правила и автозапуск */
  static apply(serverId: number): Promise<{ success: boolean; error?: string }> {
    return runExclusive(serverId, () => this.applyLocked(serverId));
  }

  /**
   * То же из уже занятой очереди ноды: ProvisionService вызывает сразу после установки, применения параметров и
   * обновления образа — контейнер пересоздан или перезапущен и мог сменить адрес. Нодам без запасных портов — ничего.
   */
  static async reapplyLocked(serverId: number): Promise<void> {
    const row = db.prepare('SELECT extra_ports, extra_ports_hash FROM servers WHERE id = ?').get(serverId) as any;
    if (!row || (!parseExtraPorts(row.extra_ports).length && !row.extra_ports_hash)) return;
    await this.applyLocked(serverId);
  }

  static async applyLocked(serverId: number): Promise<{ success: boolean; error?: string }> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!eligible(server)) return { success: false, error: 'Нода не установлена или не поддерживает запасные порты' };
    try {
      const ports = parseExtraPorts(server.extra_ports);
      const rules = rulesOf(server);
      const credentials = ProvisionService.getCredentials(server);
      const script = ports.length ? installScript(rules) : extraPortsRemoveScript();
      const result = await SshService.executeCommand(credentials, `${SshService.sudo(credentials)}sh -c ${shellQuote(script)}`, { timeoutMs: 60000 });
      if (result.code !== 0) throw new Error(result.stderr.trim() || `код ${result.code}`);
      if (ports.length && !new RegExp(`^---PORTS ${ports.length} \\d+\\.\\d+\\.\\d+\\.\\d+$`, 'm').test(result.stdout)) {
        throw new Error('Нода не подтвердила применение правил запасных портов');
      }
      db.prepare('UPDATE servers SET extra_ports_hash = ?, extra_ports_error = NULL WHERE id = ?').run(ports.length ? sha256(rules) : null, serverId);
      lastHealth.set(serverId, Date.now());
      lastFailure.delete(serverId);
      return { success: true };
    } catch (err: any) {
      lastFailure.set(serverId, Date.now());
      db.prepare('UPDATE servers SET extra_ports_error = ? WHERE id = ?').run(String(err.message).slice(0, 500), serverId);
      return { success: false, error: err.message };
    }
  }

  /**
   * Фоновая сверка (statsLoop): правила в БД изменились (порт, контейнер, список) — применить заново; раз в 5 минут —
   * проверить на ноде, что правила на месте и ведут на нынешний адрес контейнера. Недоступные ноды не трогаются.
   */
  static async checkAll(): Promise<void> {
    if (MigrationService.isBackgroundPaused()) return;
    const servers = db.prepare(`
      SELECT * FROM servers
      WHERE remote_panel_id IS NULL AND status = 'online' AND (extra_ports IS NOT NULL OR extra_ports_hash IS NOT NULL)
    `).all() as any[];
    for (const server of servers) {
      if (!eligible(server) || ProvisionService.isInstalling(server.id) || server.needs_apply) continue;
      const ports = parseExtraPorts(server.extra_ports);
      let expected: string | null;
      try {
        expected = ports.length ? sha256(rulesOf(server)) : null;
      } catch {
        continue;
      }
      if (expected !== (server.extra_ports_hash ?? null)) {
        if (Date.now() - (lastFailure.get(server.id) ?? 0) < HEALTH_INTERVAL_MS) continue;
        await this.apply(server.id).catch(() => {});
        continue;
      }
      if (!ports.length || Date.now() - (lastHealth.get(server.id) ?? 0) < HEALTH_INTERVAL_MS) continue;
      lastHealth.set(server.id, Date.now());
      await runExclusive(server.id, async () => {
        const credentials = ProvisionService.getCredentials(server);
        const result = await SshService.executeCommand(
          credentials,
          `${SshService.sudo(credentials)}sh -c ${shellQuote(healthScript(String(server.container_name), Number(server.awg_port)))}`,
          { timeoutMs: 30000 }
        );
        if (result.code !== 0) return;
        const health = parsePortsHealth(result.stdout);
        // Правила пропали (перезагрузка без systemd, чужой iptables-restore) или контейнер сменил адрес — сбросить отметку,
        // следующая сверка применит заново; до тех пор подписка запасные порты не выдаёт
        if (health.rules !== ports.length || !health.prerouting) {
          db.prepare('UPDATE servers SET extra_ports_hash = NULL WHERE id = ?').run(server.id);
        }
      }).catch(() => {});
    }
  }

  /** Для тестов: забыть время последних проверок */
  static resetHealthTimers(): void {
    lastHealth.clear();
    lastFailure.clear();
  }
}

export { MAX_EXTRA_PORTS, parseExtraPorts };
