import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, transaction } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { shellQuote } from '../utils/net.js';
import { ProvisionService } from './provision.service.js';
import { SshService } from './ssh.service.js';
import { MigrationService } from './migration.service.js';
import { EventService } from './event.service.js';
import { LiveService } from './live.service.js';

const DAY = 24 * 60 * 60 * 1000;
export interface NodeUpdateSettings { auto_update: boolean; hour_utc: number }
export interface NodeUpdateState {
  server_id: number; current_image: string | null; latest_image: string | null;
  available: number; checked_at: string | null; attempted_at: string | null;
  updated_at: string | null; result: string | null; error: string | null;
}

export class NodeUpdateService {
  private static running = false;
  private static activeServer: number | null = null;

  static settings(): NodeUpdateSettings {
    return { auto_update: getSetting('node_auto_update') === '1', hour_utc: Number(getSetting('node_update_hour') ?? 3) };
  }

  static saveSettings(input: unknown): NodeUpdateSettings {
    const value = input as Partial<NodeUpdateSettings> | null;
    if (!value || typeof value.auto_update !== 'boolean' || !Number.isInteger(value.hour_utc) || value.hour_utc! < 0 || value.hour_utc! > 23) {
      throw new HttpError(400, 'Укажите автообновление и час UTC от 0 до 23');
    }
    transaction(() => {
      setSetting('node_auto_update', value.auto_update ? '1' : '0');
      setSetting('node_update_hour', String(value.hour_utc));
    });
    return this.settings();
  }

  static state(id: number): NodeUpdateState | null {
    return db.prepare('SELECT * FROM node_updates WHERE server_id = ?').get(id) as unknown as NodeUpdateState ?? null;
  }

  static overview() {
    return {
      settings: this.settings(), running: this.running, active_server: this.activeServer,
      nodes: db.prepare(`SELECT u.*, s.name FROM node_updates u JOIN servers s ON s.id = u.server_id
        WHERE s.remote_panel_id IS NULL AND s.managed_by = 'demension' AND (s.protocol IS NULL OR s.protocol = 'awg') ORDER BY s.id`).all(),
    };
  }

  private static eligible(s: any): boolean {
    return Boolean(s && !s.remote_panel_id && s.managed_by === 'demension' && s.status === 'online' &&
      (s.protocol === null || s.protocol === undefined || s.protocol === 'awg') &&
      s.container_name === 'amnezia-awg' && s.iface === 'awg0' && s.awg_tool === 'awg' &&
      s.conf_path === '/opt/amnezia/awg/awg0.conf' && s.deployed_port === s.awg_port && !s.needs_apply && !s.needs_sync);
  }

  /** One node at a time, same queue as sync/apply/reinstall. No DB client writes and no config generation. */
  static async operate(id: number, mode: 'check' | 'update'): Promise<void> {
    await ProvisionService.maintainContainer(id, async () => {
      if (MigrationService.isBackgroundPaused()) throw new HttpError(423, 'Идёт перенос панели');
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as any;
      if (!this.eligible(server)) throw new HttpError(409, 'Обновление доступно для работающей ноды панели без ожидающих изменений');
      db.prepare('INSERT OR IGNORE INTO node_updates(server_id) VALUES (?)').run(id);
      if (mode === 'update') db.prepare('UPDATE node_updates SET attempted_at = ? WHERE server_id = ?').run(new Date().toISOString(), id);
      this.activeServer = id;
      LiveService.notify();
      let failureResult = 'error';
      let failureMessage: string | null = null;
      try {
        const credentials = ProvisionService.getCredentials(server);
        const script = [
          `export AWG_CONTAINER=${shellQuote(server.container_name)}`,
          `export AWG_PORT=${shellQuote(server.awg_port)}`,
          `export AWG_MODE=${shellQuote(mode)}`,
          fs.readFileSync(fileURLToPath(new URL('../scripts/update-awg.sh', import.meta.url)), 'utf8'),
        ].join('\n');
        const result = await SshService.executeCommand(credentials,
          // Remote deadline precedes SSH timeout, so a detached pull cannot replace the container after the queue unlocks.
          `${SshService.sudo(credentials)}timeout --signal=TERM --kill-after=30s 18m bash -c 'script=$(cat); exec bash -c "$script"'`,
          { input: script, timeoutMs: 20 * 60 * 1000 });
        const images = /^---DEMENTIA_IMAGE--- (sha256:[a-f0-9]{64}) (sha256:[a-f0-9]{64})$/m.exec(result.stdout);
        const updated = /^---DEMENTIA_UPDATED---$/m.test(result.stdout);
        if (result.code !== 0 || !images || (mode === 'update' && images[1] !== images[2] && !updated)) {
          const rolledBack = /^---DEMENTIA_ROLLED_BACK---$/m.test(result.stdout);
          failureResult = rolledBack ? 'rolled_back' : 'error';
          if (rolledBack) failureMessage = 'Обновление не прошло проверку; прежний контейнер восстановлен со всеми пирами';
          else if (/^---DEMENTIA_CONFIG_MISMATCH---$/m.test(result.stdout)) {
            failureMessage = 'Обновление отменено до остановки: работающие ключи, порт или пиры отличаются от сохранённого конфига';
          } else if (/^---DEMENTIA_BACKUP_EXISTS---$/m.test(result.stdout)) {
            failureMessage = 'Остался резервный контейнер предыдущего обновления. Проверьте и восстановите ноду перед повтором';
          } else if (/^---DEMENTIA_ROLLBACK_FAILED---$/m.test(result.stderr)) {
            failureMessage = 'Не удалось автоматически восстановить прежний контейнер. Ноде требуется ручное восстановление';
          }
          // Never expose remote stdout/stderr: it may contain secrets or attacker-controlled data.
          throw new Error(rolledBack ? 'Обновление не прошло проверку; прежний контейнер восстановлен' :
            'Обновление или проверка образа не завершены; проверьте ноду и резервный контейнер');
        }
        const previous = this.state(id);
        const available = !updated && images[1] !== images[2];
        const now = new Date().toISOString();
        db.prepare(`UPDATE node_updates SET current_image = ?, latest_image = ?, available = ?, checked_at = ?,
          updated_at = CASE WHEN ? THEN ? ELSE updated_at END, result = ?, error = NULL WHERE server_id = ?`).run(
          updated ? images[2] : images[1], images[2], available ? 1 : 0, now, updated ? 1 : 0, now,
          updated ? 'updated' : available ? 'available' : 'current', id);
        if (updated) {
          db.prepare('UPDATE servers SET node_info_at = NULL WHERE id = ?').run(id);
          // Контейнер пересоздан и мог сменить адрес в сети Docker — правила запасных портов применяются заново
          await ProvisionService.reapplyExtraPorts(id);
          EventService.log('info', 'node.updated', `AmneziaWG на ноде «${server.name}» обновлён; все пиры и ключи сохранены`, { kind: 'server', id });
        } else if (available && (!previous?.available || previous.latest_image !== images[2])) {
          EventService.log('info', 'node.update_available', `Для ноды «${server.name}» доступен новый образ AmneziaWG`, { kind: 'server', id });
        }
      } catch {
        // Also throttle failed checks and automatic update attempts (no restart loop).
        const message = failureMessage ?? (mode === 'update'
          ? 'Не удалось обновить AmneziaWG. При сбое запуска выполнена попытка отката; проверьте состояние ноды.'
          : 'Не удалось проверить образ AmneziaWG. Проверьте SSH, Docker и доступ к реестру.');
        db.prepare('UPDATE node_updates SET checked_at = ?, result = ?, error = ? WHERE server_id = ?').run(
          new Date().toISOString(), failureResult, message, id);
        EventService.log('error', mode === 'update' ? 'node.update_failed' : 'node.update_check_failed', `${server.name}: ${message}`, { kind: 'server', id });
        throw new HttpError(502, message);
      } finally {
        this.activeServer = null;
        LiveService.notify();
      }
    });
  }

  /** Shared lock covers manual batches and the scheduler. POST returns immediately; progress is readable via GET. */
  static start(mode: 'check' | 'update', ids?: number[]): void {
    if (this.running) throw new HttpError(409, 'Проверка или обновление уже выполняется');
    if (MigrationService.isBackgroundPaused()) throw new HttpError(423, 'Идёт перенос панели');
    if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000 || ids.some((id) => !Number.isSafeInteger(id) || id < 1))) {
      throw new HttpError(400, 'Некорректный список нод');
    }
    const servers = this.servers().filter((s) => !ids || ids.includes(s.id));
    if (ids && new Set(ids).size !== servers.length) throw new HttpError(409, 'Некоторые ноды недоступны для обновления');
    const targets = servers.filter((s) => mode === 'check' || ids || this.state(s.id)?.available);
    this.running = true;
    void this.batch(mode, targets.map((s) => s.id))
      .catch(() => { console.error('[NODE UPDATE] Пакет обслуживания прерван'); })
      .finally(() => { this.running = false; LiveService.notify(); });
  }

  private static servers(): any[] {
    return (db.prepare("SELECT * FROM servers WHERE remote_panel_id IS NULL AND managed_by = 'demension' ORDER BY id").all() as any[]).filter((s) => this.eligible(s));
  }

  private static async batch(mode: 'check' | 'update', ids: number[]): Promise<void> {
    for (const id of ids) {
      if (MigrationService.isBackgroundPaused()) break;
      try { await this.operate(id, mode); } catch { /* Each failure is recorded; other nodes can proceed. */ }
    }
  }

  static async tick(now = new Date()): Promise<void> {
    if (this.running || MigrationService.isBackgroundPaused()) return;
    this.running = true;
    const started = Date.now();
    try {
      const due = this.servers().filter((s) => now.getTime() - Date.parse(this.state(s.id)?.checked_at ?? '') >= DAY || !this.state(s.id)?.checked_at);
      await this.batch('check', due.map((s) => s.id));
      const settings = this.settings();
      if (settings.auto_update && now.getUTCHours() === settings.hour_utc) {
        for (const s of this.servers()) {
          if (MigrationService.isBackgroundPaused() || !this.settings().auto_update ||
            this.settings().hour_utc !== settings.hour_utc || new Date(now.getTime() + Date.now() - started).getUTCHours() !== settings.hour_utc) break;
          const state = this.state(s.id);
          if (state?.available && !state.error && (!state.attempted_at || now.getTime() - Date.parse(state.attempted_at) >= DAY)) {
            await this.batch('update', [s.id]);
          }
        }
      }
    } finally { this.running = false; LiveService.notify(); }
  }
}
