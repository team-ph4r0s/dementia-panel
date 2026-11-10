import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { dbFile } from '../config.js';
import { allocateIp } from '../utils/net.js';
import { encryptSecret } from '../services/secrets.service.js';

export const db = new DatabaseSync(dbFile);

// Enable WAL mode for better concurrency and performance
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

/**
 * Выполняет функцию в транзакции; при исключении изменения откатываются.
 */
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
}

function hasColumn(table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((c) => c.name === column);
}

function addColumn(table: string, definition: string): void {
  const column = definition.split(/\s+/)[0];
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition};`);
  }
}

const migrations: Array<() => void> = [
  // v1: исходная схема
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        admin_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        traffic_limit INTEGER NOT NULL DEFAULT 0,
        expire_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        ssh_port INTEGER NOT NULL DEFAULT 22,
        ssh_user TEXT NOT NULL DEFAULT 'root',
        ssh_password TEXT,
        ssh_key TEXT,
        awg_port INTEGER NOT NULL DEFAULT 51820,
        subnet TEXT NOT NULL DEFAULT '10.8.0.1/24',
        server_public_key TEXT,
        server_private_key TEXT,
        preshared_key TEXT,
        jc INTEGER NOT NULL DEFAULT 4,
        jmin INTEGER NOT NULL DEFAULT 40,
        jmax INTEGER NOT NULL DEFAULT 70,
        s1 INTEGER NOT NULL DEFAULT 36,
        s2 INTEGER NOT NULL DEFAULT 124,
        h1 INTEGER NOT NULL DEFAULT 124357689,
        h2 INTEGER NOT NULL DEFAULT 987654321,
        h3 INTEGER NOT NULL DEFAULT 135792468,
        h4 INTEGER NOT NULL DEFAULT 246813579,
        status TEXT NOT NULL DEFAULT 'uninstalled',
        last_seen TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL,
        subscriber_id INTEGER,
        name TEXT NOT NULL,
        client_ip TEXT NOT NULL,
        client_public_key TEXT NOT NULL,
        client_private_key TEXT NOT NULL,
        preshared_key TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        total_rx INTEGER NOT NULL DEFAULT 0,
        total_tx INTEGER NOT NULL DEFAULT 0,
        last_handshake TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
        FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    addColumn('clients', 'subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE CASCADE');
  },

  // v2: синхронизация, TOFU-ключи хостов, накопление трафика, лимиты, шифрование секретов
  () => {
    addColumn('servers', 'host_key TEXT');
    addColumn('servers', 'needs_sync INTEGER NOT NULL DEFAULT 0');
    addColumn('servers', 'needs_apply INTEGER NOT NULL DEFAULT 0');
    addColumn('servers', 'deployed_port INTEGER');
    addColumn('servers', 'last_error TEXT');
    addColumn('servers', 'fail_count INTEGER NOT NULL DEFAULT 0');
    addColumn('clients', 'rx_counter INTEGER NOT NULL DEFAULT 0');
    addColumn('clients', 'tx_counter INTEGER NOT NULL DEFAULT 0');
    addColumn('subscribers', 'suspended INTEGER NOT NULL DEFAULT 0');

    // Уже установленные серверы считаем развёрнутыми на текущем порту
    db.exec("UPDATE servers SET deployed_port = awg_port WHERE status != 'uninstalled' AND deployed_port IS NULL");

    // Устранение дублей IP перед созданием уникального индекса
    const duplicates = db.prepare(`
      SELECT c.id, c.server_id, s.subnet FROM clients c
      JOIN servers s ON s.id = c.server_id
      WHERE EXISTS (
        SELECT 1 FROM clients d
        WHERE d.server_id = c.server_id AND d.client_ip = c.client_ip AND d.id < c.id
      )
    `).all() as { id: number; server_id: number; subnet: string }[];
    for (const dup of duplicates) {
      const used = (db.prepare('SELECT client_ip FROM clients WHERE server_id = ?').all(dup.server_id) as { client_ip: string }[])
        .map((r) => r.client_ip);
      db.prepare('UPDATE clients SET client_ip = ? WHERE id = ?').run(allocateIp(dup.subnet, used), dup.id);
      db.prepare('UPDATE servers SET needs_sync = 1 WHERE id = ?').run(dup.server_id);
      console.warn(`[DB] Клиент #${dup.id} имел дублирующийся IP — назначен новый адрес`);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_server_ip ON clients(server_id, client_ip);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clients_subscriber ON clients(subscriber_id);');

    // Шифрование ранее сохранённых SSH-секретов и токена Cloudflare
    const servers = db.prepare('SELECT id, ssh_password, ssh_key FROM servers').all() as {
      id: number;
      ssh_password: string | null;
      ssh_key: string | null;
    }[];
    for (const s of servers) {
      db.prepare('UPDATE servers SET ssh_password = ?, ssh_key = ? WHERE id = ?').run(
        encryptSecret(s.ssh_password),
        encryptSecret(s.ssh_key),
        s.id
      );
    }
    const cfToken = getSetting('cf_token');
    if (cfToken) setSetting('cf_token', encryptSecret(cfToken));

    // Токены сессий теперь хранятся в виде SHA-256 — старые сессии недействительны
    db.exec('DELETE FROM sessions;');
  },

  // v3: отображаемые имена и порядок серверов в подписке, образ AmneziaWG больше не настраивается
  () => {
    addColumn('servers', 'sub_name TEXT');
    addColumn('servers', 'sub_order INTEGER NOT NULL DEFAULT 0');
    db.exec("DELETE FROM settings WHERE key = 'awg_image'");
  },

  // v4: параметры AmneziaWG 3.x и работа с уже установленными контейнерами (в т.ч. приложения Amnezia)
  () => {
    addColumn('servers', 'awg_version INTEGER NOT NULL DEFAULT 1');
    addColumn('servers', 's3 INTEGER');
    addColumn('servers', 's4 INTEGER');
    for (const key of ['i1', 'i2', 'i3', 'i4', 'i5']) addColumn('servers', `${key} TEXT`);
    addColumn('servers', 'header_protection_key TEXT');
    addColumn('servers', 'extra_params TEXT');
    // Где живёт AmneziaWG на ноде: имя контейнера, интерфейс, путь к конфигу внутри контейнера, утилита (awg/wg)
    addColumn('servers', "container_name TEXT NOT NULL DEFAULT 'amnezia-awg'");
    addColumn('servers', "iface TEXT NOT NULL DEFAULT 'awg0'");
    addColumn('servers', "conf_path TEXT NOT NULL DEFAULT '/opt/amnezia/awg/awg0.conf'");
    addColumn('servers', "awg_tool TEXT NOT NULL DEFAULT 'awg'");
    // dementia — контейнер, развёрнутый панелью; amnezia — найденный контейнер приложения Amnezia
    addColumn('servers', "managed_by TEXT NOT NULL DEFAULT 'demension'");
    // Пиры, импортированные из существующей установки: приватный ключ клиента панели неизвестен
    addColumn('clients', 'external INTEGER NOT NULL DEFAULT 0');
  },

  // v5: партнёрский доступ к нодам между панелями
  () => {
    db.exec(`
      -- Сторона владельца нод: выданные партнёрам доступы
      CREATE TABLE IF NOT EXISTS partners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        token_hint TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        suspended INTEGER NOT NULL DEFAULT 0,
        max_clients INTEGER NOT NULL DEFAULT 0,
        traffic_limit INTEGER NOT NULL DEFAULT 0,
        expire_at TEXT,
        last_used_at TEXT,
        last_ip TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS partner_nodes (
        partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        PRIMARY KEY (partner_id, server_id)
      );

      CREATE TABLE IF NOT EXISTS partner_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        details TEXT,
        ip TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_partner_audit ON partner_audit(partner_id, id);

      -- Сторона получателя: подключённые панели партнёров
      CREATE TABLE IF NOT EXISTS remote_panels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        token TEXT NOT NULL,
        partner_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        limits TEXT,
        last_sync_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Владелец: клиент создан партнёром; owner_blocked — заблокирован владельцем (партнёр не может включить)
    addColumn('clients', 'partner_id INTEGER REFERENCES partners(id) ON DELETE CASCADE');
    addColumn('clients', 'remote_ref TEXT');
    addColumn('clients', 'owner_blocked INTEGER NOT NULL DEFAULT 0');
    // Получатель: идентификатор пира на панели владельца и его состояние
    addColumn('clients', 'remote_peer_id INTEGER');
    addColumn('clients', 'remote_state TEXT');
    // Получатель: нода партнёра хранится как сервер без SSH-доступа
    addColumn('servers', 'remote_panel_id INTEGER REFERENCES remote_panels(id) ON DELETE CASCADE');
    addColumn('servers', 'remote_node_id INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clients_partner ON clients(partner_id);');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_remote ON servers(remote_panel_id, remote_node_id);');
  },

  // v6: уникальность ключа клиента на ноде и IP, с которых администратор входил в панель
  () => {
    // Две секции [Peer] с одним ключом перехватывают трафик друг друга. Уже существующие дубли (их ключи
    // менять нельзя — они известны клиентам) индекс не создаётся, новые дубли отсекает проверка в коде.
    const duplicate = db.prepare('SELECT 1 FROM clients GROUP BY server_id, client_public_key HAVING COUNT(*) > 1 LIMIT 1').get();
    if (duplicate) {
      console.warn('[DB] На нодах есть клиенты с одинаковым публичным ключом — уникальный индекс не создан, устраните дубли вручную');
    } else {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_server_pubkey ON clients(server_id, client_public_key);');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS trusted_login_ips (
        ip TEXT PRIMARY KEY,
        last_login_at TEXT NOT NULL
      );
    `);
  },

  // v7: версии ПО AmneziaWG на ноде (собираются фоновым опросом)
  () => {
    addColumn('servers', 'node_awg_go TEXT');
    addColumn('servers', 'node_awg_tools TEXT');
    addColumn('servers', 'node_image TEXT');
    addColumn('servers', 'node_image_created TEXT');
    addColumn('servers', 'node_info_at TEXT');
  },

  // v8: проверка доступности нод из выбранных стран (check-host.net)
  () => {
    // NULL — проверка ICMP-ping, число — TCP-подключение к этому порту (для нод, где ping закрыт)
    addColumn('servers', 'probe_port INTEGER');
    db.exec(`
      CREATE TABLE IF NOT EXISTS probe_results (
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        country TEXT NOT NULL,
        ok_nodes INTEGER NOT NULL,
        total_nodes INTEGER NOT NULL,
        rtt_ms INTEGER,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (server_id, country)
      );
    `);
  },

  // v9: заглушка для проверки доступности на ноде, мосты в странах клиентов, страна пользователя
  () => {
    // Порт заглушки dementia-probe на ноде (NULL — не установлена) и метка, которую она отдаёт в ответе
    addColumn('servers', 'stub_port INTEGER');
    addColumn('servers', 'stub_token TEXT');
    // Результат проверки: дошли ли запросы проверяющих узлов до ноды по журналу заглушки
    addColumn('probe_results', "method TEXT NOT NULL DEFAULT 'ping'");
    addColumn('probe_results', 'tcp_ok INTEGER');
    addColumn('probe_results', 'udp_ok INTEGER');
    addColumn('probe_results', 'spoofed INTEGER NOT NULL DEFAULT 0');
    addColumn('probe_results', 'verified INTEGER NOT NULL DEFAULT 0');
    // Страна пользователя (ISO 3166-1 alpha-2, нижний регистр): по ней выбирается мост
    addColumn('subscribers', 'country TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS bridges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        ssh_port INTEGER NOT NULL DEFAULT 22,
        ssh_user TEXT NOT NULL DEFAULT 'root',
        ssh_password TEXT,
        ssh_key TEXT,
        host_key TEXT,
        country TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'uninstalled',
        -- SHA-256 применённых на мосту правил: расхождение с правилами из БД — повод применить заново
        rules_hash TEXT,
        needs_apply INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_seen TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Мост пересылает UDP listen_port на порт AmneziaWG ноды (и TCP listen_port на её заглушку)
      CREATE TABLE IF NOT EXISTS bridge_links (
        bridge_id INTEGER NOT NULL REFERENCES bridges(id) ON DELETE CASCADE,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        listen_port INTEGER NOT NULL,
        -- auto — по проверкам, always — всегда через мост, off — не использовать
        mode TEXT NOT NULL DEFAULT 'auto',
        check_ok INTEGER,
        checked_at TEXT,
        PRIMARY KEY (bridge_id, server_id),
        UNIQUE (bridge_id, listen_port)
      );

      -- Нужен ли мост пользователям страны для ноды (решение по проверкам с гистерезисом)
      CREATE TABLE IF NOT EXISTS bridge_state (
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        country TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        fail_streak INTEGER NOT NULL DEFAULT 0,
        ok_streak INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        changed_at TEXT,
        PRIMARY KEY (server_id, country)
      );
    `);
  },

  // v10: журнал событий панели
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        entity_kind TEXT,
        entity_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
      CREATE INDEX IF NOT EXISTS idx_events_level_id ON events(level, id);
    `);
  },

  // v11: 2FA (TOTP, recovery codes) и расширенная таблица сессий (IP, User-Agent, last activity)
  () => {
    addColumn('admins', 'totp_secret TEXT DEFAULT NULL');
    addColumn('admins', 'totp_enabled INTEGER NOT NULL DEFAULT 0');
    addColumn('admins', 'recovery_codes TEXT DEFAULT NULL'); // JSON-массив SHA-256 хэшей

    db.exec(`
      -- Пересоздаём таблицу sessions с дополнительными полями
      CREATE TABLE sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        admin_id INTEGER NOT NULL,
        ip TEXT DEFAULT NULL,
        user_agent TEXT DEFAULT NULL,
        last_activity TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_sessions_token ON sessions_new(token);
      CREATE INDEX idx_sessions_admin_activity ON sessions_new(admin_id, last_activity);

      -- Переносим существующие сессии (IP и user_agent заполнятся при следующей активности)
      INSERT INTO sessions_new (token, admin_id, expires_at, created_at, last_activity)
      SELECT token, admin_id, expires_at, created_at, created_at FROM sessions ORDER BY rowid;

      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
  },

  // v12: гостевой доступ — роль сессии (admin | guest); логин и пароль гостя лежат в settings (guest_*)
  () => {
    addColumn('sessions', "role TEXT NOT NULL DEFAULT 'admin'");
  },
  // v13: state of image checks and updates; client records and keys are untouched.
  () => {
    db.exec(`CREATE TABLE node_updates (
      server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      current_image TEXT,
      latest_image TEXT,
      available INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT,
      attempted_at TEXT,
      updated_at TEXT,
      result TEXT,
      error TEXT
    )`);
  },
  // v14: география ноды для глобуса
  () => {
    addColumn('servers', 'country TEXT');
  },
  // v15: протокол ноды (awg | vless). Для VLESS + Reality порт — awg_port (TCP), ключи Reality x25519 —
  // server_private_key/server_public_key (base64, как у AWG); клиент VLESS — client_uuid без IP и ключей
  () => {
    addColumn('servers', "protocol TEXT NOT NULL DEFAULT 'awg'");
    addColumn('servers', 'reality_sni TEXT');
    addColumn('servers', 'reality_dest TEXT');
    addColumn('servers', 'reality_short_ids TEXT'); // JSON-массив hex-строк
    addColumn('servers', 'xray_flow TEXT');
    addColumn('servers', 'xray_fingerprint TEXT');
    addColumn('clients', 'client_uuid TEXT');
    // У клиентов VLESS нет IP и публичного ключа (пустые строки): уникальность — только для непустых значений
    db.exec(`
      DROP INDEX IF EXISTS idx_clients_server_ip;
      CREATE UNIQUE INDEX idx_clients_server_ip ON clients(server_id, client_ip) WHERE client_ip <> '';
      CREATE UNIQUE INDEX idx_clients_server_uuid ON clients(server_id, client_uuid) WHERE client_uuid IS NOT NULL;
    `);
    // Индекс ключей мог не создаться в v6 из-за старых дублей — тогда его не создаём и сейчас
    const hadPubkeyIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_clients_server_pubkey'").get();
    if (hadPubkeyIndex) {
      db.exec(`
        DROP INDEX idx_clients_server_pubkey;
        CREATE UNIQUE INDEX idx_clients_server_pubkey ON clients(server_id, client_public_key) WHERE client_public_key <> '';
      `);
    }
  },
  // v16: транспорт VLESS (tcp | xhttp) и вход через CDN Cloudflare (VLESS + XHTTP + TLS, docs/vless.md).
  // cdn_key — приватный ключ сертификата (encryptSecret), в API не отдаётся
  () => {
    addColumn('servers', 'xray_transport TEXT');
    addColumn('servers', 'xhttp_path TEXT');
    addColumn('servers', 'xhttp_mode TEXT');
    addColumn('servers', 'cdn_enabled INTEGER NOT NULL DEFAULT 0');
    addColumn('servers', 'cdn_domain TEXT');
    addColumn('servers', 'cdn_port INTEGER');
    addColumn('servers', 'cdn_address TEXT');
    addColumn('servers', 'cdn_zone TEXT');
    addColumn('servers', 'cdn_record TEXT');
    addColumn('servers', 'cdn_origin_ip TEXT');
    addColumn('servers', 'cdn_cert TEXT');
    addColumn('servers', 'cdn_key TEXT');
    addColumn('servers', 'cdn_expires_at TEXT');
    addColumn('servers', 'cdn_error TEXT');
    // Случайный путь XHTTP уже существующим VLESS-нодам: «/» легко угадать при активном зондировании
    const update = db.prepare('UPDATE servers SET xhttp_path = ? WHERE id = ?');
    for (const row of db.prepare("SELECT id FROM servers WHERE protocol = 'vless'").all() as { id: number }[]) {
      update.run(`/${crypto.randomBytes(8).toString('hex')}`, row.id);
    }
  },
  // v17: мост пересылает порт панели (резервный путь к панели и подпискам, docs/bridges.md#panel); резервный домен подписок —
  // в settings (failover_*), режим привязки `main` — значение bridge_links.mode без изменения схемы
  () => {
    addColumn('bridges', 'panel_forward INTEGER NOT NULL DEFAULT 0');
  },
  // v18: запасные порты ноды AmneziaWG (docs/node-management.md#extra-ports): список (JSON), SHA-256 применённых на ноде
  // правил (NULL — не применены, в подписку порты не попадают) и текст последней ошибки применения
  () => {
    addColumn('servers', 'extra_ports TEXT');
    addColumn('servers', 'extra_ports_hash TEXT');
    addColumn('servers', 'extra_ports_error TEXT');
  },
  // v19: второй источник проверки из стран — Globalping (docs/probes.md): сколько проб страны дошло до заглушки ноды и
  // сколько участвовало, и были ли это пробы в сетях провайдеров (1) или только в дата-центрах (0). NULL — источник не использовался
  () => {
    addColumn('probe_results', 'gp_ok INTEGER');
    addColumn('probe_results', 'gp_total INTEGER');
    addColumn('probe_results', 'gp_eyeball INTEGER');
  },
  // v20: транспорт моста XHTTP Reality. NULL — прежняя пересылка DNAT.
  () => {
    addColumn('bridge_links', 'cascade_port INTEGER');
    addColumn('bridge_links', 'cascade_secret TEXT');
    addColumn('bridge_links', 'cascade_pending INTEGER NOT NULL DEFAULT 0');
  },
  // v21: вкладка «Провайдеры» (docs/providers.md): личный кабинет, платёж и дата для панели (target_id = 0), ноды и моста.
  // password — encryptSecret, в списке не отдаётся. provider_reminders помнит, какие напоминания уже ушли в Telegram
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_accounts (
        target_type TEXT NOT NULL CHECK (target_type IN ('panel', 'node', 'bridge')),
        target_id INTEGER NOT NULL DEFAULT 0,
        url TEXT,
        login TEXT,
        password TEXT,
        amount REAL,
        currency TEXT NOT NULL DEFAULT 'RUB',
        pay_day INTEGER,
        pay_month INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (target_type, target_id)
      );

      CREATE TABLE IF NOT EXISTS provider_reminders (
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        due_date TEXT NOT NULL,
        days_before INTEGER NOT NULL,
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (target_type, target_id, due_date, days_before)
      );
    `);
  },
];

/** Версия схемы, которую умеет эта сборка панели (число миграций) */
export const SCHEMA_VERSION = migrations.length;

/**
 * Применяет недостающие миграции. `targetVersion` позволяет остановиться раньше — так тесты воспроизводят БД старой версии.
 */
export function initDatabase(targetVersion = migrations.length) {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let version = current; version < Math.min(targetVersion, migrations.length); version++) {
    transaction(() => {
      migrations[version]();
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}
