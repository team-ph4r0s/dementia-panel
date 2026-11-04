export interface AdminUser {
  id: number;
  username: string;
  /** guest — гостевой доступ только для просмотра; нет поля у старых ответов — администратор */
  role?: 'admin' | 'guest';
}

export interface GuestAccess {
  enabled: boolean;
  username: string;
  has_password: boolean;
}

export interface Subscriber {
  id: number;
  name: string;
  token: string;
  enabled: number;
  /** Лимит трафика в байтах (0 — без лимита) */
  traffic_limit: number;
  expire_at: string | null;
  created_at: string;
  /** Приостановлена из-за истечения срока или превышения лимита */
  suspended: boolean;
  expired: boolean;
  /** Отправлено пользователем (upload) */
  total_rx: number;
  /** Получено пользователем (download) */
  total_tx: number;
  traffic_used: number;
  peer_count: number;
  server_ids: number[];
  servers: {
    id: number;
    name: string;
    host: string;
    client_ip: string;
    enabled: number;
  }[];
  /** Страна пользователя (код ISO в нижнем регистре): по ней подписка выбирает мост; null — не задана */
  country: string | null;
}

export type ServerStatus = 'uninstalled' | 'installing' | 'online' | 'offline' | 'error';

export interface Server {
  id: number;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  has_ssh_password: boolean;
  has_ssh_key: boolean;
  host_key: string | null;
  awg_port: number;
  deployed_port: number | null;
  subnet: string;
  server_public_key: string | null;
  /** 1 — устаревший формат AmneziaWG 1.x, 3 — актуальный 3.x */
  awg_version: number;
  latest_awg_version: number;
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  s3: number | null;
  s4: number | null;
  /** Число или диапазон «a-b» */
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  i1: string | null;
  i2: string | null;
  i3: string | null;
  i4: string | null;
  i5: string | null;
  header_protection_key: string | null;
  extra_params: Record<string, string>;
  /** Контейнер на ноде: панели (dementia) или найденный контейнер приложения Amnezia */
  container_name: string;
  managed_by: 'demension' | 'amnezia' | 'partner';
  /** Нода партнёрской панели (управляется владельцем, без SSH) */
  remote_panel_id: number | null;
  remote_panel_name: string | null;
  remote_panel_status: string | null;
  status: ServerStatus;
  needs_sync: boolean;
  needs_apply: boolean;
  installing: boolean;
  last_error: string | null;
  client_count?: number;
  active_client_count?: number;
  last_seen?: string;
  created_at: string;
  /** Версии ПО AmneziaWG на ноде (собираются фоновым опросом; у нод партнёра — null) */
  node_awg_go: string | null;
  node_awg_tools: string | null;
  node_image: string | null;
  node_image_created: string | null;
  node_info_at: string | null;
  node_update?: NodeImageState | null;
  /** Доступность из выбранных стран (пусто, пока проверка выключена) */
  probes?: ProbeResult[];
  /** Порт заглушки проверки доступности на ноде (null — не установлена) */
  stub_port: number | null;
}

export interface NodeImageState {
  server_id: number;
  name?: string;
  available: number;
  current_image: string | null;
  latest_image: string | null;
  checked_at: string | null;
  attempted_at: string | null;
  updated_at: string | null;
  result: string | null;
  error: string | null;
}

export interface NodeUpdateSettings { auto_update: boolean; hour_utc: number }
export interface NodeUpdatesOverview {
  settings: NodeUpdateSettings;
  running: boolean;
  active_server: number | null;
  nodes: NodeImageState[];
}

/** Версия панели и последний релиз на GitHub (GET /api/version) */
export interface VersionInfo {
  current: string;
  latest: string | null;
  latest_url: string | null;
  published_at: string | null;
  update_available: boolean;
  releases_url: string;
  checked_at: string | null;
  check_enabled: boolean;
  error: string | null;
}

/** Обновление панели из интерфейса: GET/POST /api/version/update */
export interface PanelUpdateStatus {
  available: boolean;
  reason: string | null;
  current: string;
  state: 'idle' | 'running' | 'success' | 'failed' | 'rolled_back';
  from: string | null;
  to: string | null;
  started_at: string | null;
  finished_at: string | null;
  message: string | null;
  log: string;
}

export interface ServerUpdate {
  name?: string;
  host?: string;
  ssh_port?: number;
  ssh_user?: string;
  auth_type?: 'password' | 'key';
  ssh_password?: string;
  ssh_key?: string;
  reset_host_key?: boolean;
  awg_port?: number;
  subnet?: string;
  jc?: number;
  jmin?: number;
  jmax?: number;
  s1?: number;
  s2?: number;
  s3?: number | null;
  s4?: number | null;
  h1?: string;
  h2?: string;
  h3?: string;
  h4?: string;
  i1?: string | null;
  i2?: string | null;
  i3?: string | null;
  i4?: string | null;
  i5?: string | null;
  header_protection_key?: string | null;
}

export interface ScanResult {
  found: boolean;
  message: string;
  containers: { name: string; image: string; running: boolean; managedBy: string }[];
  adopted?: {
    container: string;
    managedBy: string;
    awgVersion: number;
    port: number;
    subnet: string;
    importedPeers: number;
    skippedPeers: number;
  };
  server: Server;
}

export interface Client {
  id: number;
  server_id: number;
  subscriber_id?: number | null;
  name: string;
  client_ip: string;
  client_public_key: string;
  preshared_key: string;
  enabled: number;
  /** Импортирован из существующей установки: приватный ключ неизвестен, конфиг недоступен */
  external: boolean;
  /** Создан панелью партнёра (на своей ноде) */
  partner_id?: number | null;
  partner_name?: string | null;
  /** Заблокирован владельцем ноды */
  owner_blocked: boolean;
  /** Нода партнёра: клиент ещё не создан у владельца */
  pending: boolean;
  /** Нода партнёра: 'blocked' — заблокирован владельцем, 'error: …' — ошибка создания */
  remote_state: string | null;
  /** Отправлено клиентом (upload) */
  total_rx: number;
  /** Получено клиентом (download) */
  total_tx: number;
  last_handshake: string | null;
  created_at: string;
}

export interface QrCodeData {
  qrcode: string;
  config: string;
  clientName: string;
}

export interface SslStatus {
  enabled: boolean;
  hasCert: boolean;
  domain: string | null;
  mode: 'letsencrypt_cf' | 'letsencrypt_http' | 'selfsigned_ip' | 'custom' | null;
  expiresAt: string | null;
  autoRenew: boolean;
}

export interface Fail2banStatus {
  installed: boolean;
  active: boolean;
  jail: string;
  totalFailed: number;
  totalBanned: number;
  currentlyBanned: string[];
  maxRetry: number;
  banTime: number;
  findTime: number;
}

export interface CloudflareZone {
  id: string;
  name: string;
}

export interface PanelSettings {
  public_url: string;
  client_dns: string;
  client_mtu: number;
}

export interface SubscriptionSettings {
  title: string;
  description: string;
  update_interval: number;
  announce: string;
  announce_url: string;
  support_url: string;
  support_email: string;
  web_page_url: string;
  sort_order: '' | 'ping' | 'name' | 'none';
  hide_url: boolean;
}

export interface SubscriptionServer {
  id: number;
  name: string;
  host: string;
  status: ServerStatus;
  sub_name: string | null;
  sub_order: number;
}

export interface PartnerUsage {
  clients: number;
  upload: number;
  download: number;
  used: number;
}

export interface Partner {
  id: number;
  name: string;
  token_hint: string;
  enabled: boolean;
  suspended: boolean;
  expired: boolean;
  max_clients: number;
  traffic_limit: number;
  expire_at: string | null;
  last_used_at: string | null;
  last_ip: string | null;
  created_at: string;
  node_ids: number[];
  usage: PartnerUsage;
}

export interface PartnerClient {
  id: number;
  server_id: number;
  server_name: string;
  name: string;
  client_ip: string;
  enabled: boolean;
  owner_blocked: boolean;
  total_rx: number;
  total_tx: number;
  last_handshake: string | null;
  created_at: string;
}

export interface PartnerAuditEntry {
  id: number;
  action: string;
  details: string | null;
  ip: string | null;
  created_at: string;
}

export interface RemotePanel {
  id: number;
  name: string;
  base_url: string;
  partner_name: string | null;
  status: 'pending' | 'online' | 'error' | 'revoked';
  limits: { max_clients: number; traffic_limit: number; expire_at: string | null; suspended: boolean; usage: PartnerUsage } | null;
  last_sync_at: string | null;
  last_error: string | null;
  node_count: number;
  client_count: number;
}

/** Проверка доступности нод из стран (check-host.net) */
export type ProbeStatus = 'ok' | 'partial' | 'fail';

export interface ProbeResult {
  server_id: number;
  country: string;
  /** stub — заглушка с подтверждением по журналу ноды, tcp — подключение к порту (без подтверждения) */
  method: 'stub' | 'tcp' | string;
  ok_nodes: number;
  total_nodes: number;
  /** Сколько узлов дошло до ноды по TCP и по UDP (по журналу заглушки); null — неизвестно */
  tcp_ok: number | null;
  udp_ok: number | null;
  /** Узлы, получившие ответ, хотя до ноды запрос не дошёл (подмена ответа) */
  spoofed: number;
  verified: boolean;
  rtt_ms: number | null;
  checked_at: string;
  status: ProbeStatus;
}

export interface ProbeSettings {
  enabled: boolean;
  countries: string[];
  interval_minutes: number;
  show_in_name: boolean;
  show_in_description: boolean;
}

export interface ProbeCountry {
  code: string;
  name: string;
  nodes: string[];
  cities: string[];
}

export interface ProbesOverview {
  settings: ProbeSettings;
  status: { running: boolean; last_run: string | null; error: string | null; next_run: string | null };
  max_countries: number;
  servers: { id: number; name: string; host: string; status: ServerStatus; probe_port: number | null; stub_port: number | null; remote_panel_id: number | null }[];
  results: ProbeResult[];
}

/** Перенос панели на другой сервер (GET /api/migration/status) */
export interface MigrationStatus {
  /** idle — обычная работа; prepared — выдан код; exporting — архив передан, изменения блокируются; migrated — панель заморожена */
  state: 'idle' | 'prepared' | 'exporting' | 'migrated';
  expiresAt: string | null;
  exportedAt: string | null;
  migratedAt: string | null;
  newUrl: string | null;
}

export interface AmneziaImportResult {
  key: string;
  name?: string;
  serverId?: number;
  status: 'adopted' | 'needs_install' | 'ssh_error' | 'exists' | 'invalid';
  message: string;
  importedPeers?: number;
}

/** Мост в стране пользователей (docs/bridges.md) */
export type BridgeStatus = 'uninstalled' | 'installing' | 'online' | 'offline' | 'error';
export type BridgeLinkMode = 'auto' | 'always' | 'off';

export interface BridgeLink {
  server_id: number;
  server_name: string;
  server_host: string;
  awg_port: number;
  /** Порт на мосту: UDP — на AmneziaWG ноды, TCP — на заглушку ноды */
  listen_port: number;
  mode: BridgeLinkMode;
  /** Сквозная проверка пересылки до заглушки ноды; null — ещё не проверялось */
  check_ok: boolean | null;
  checked_at: string | null;
  /** Мост сейчас выдаётся пользователям страны моста (режим auto) */
  active: boolean;
  /** probe — по проверке из страны, clients — по обрыву рукопожатий клиентов */
  reason: 'probe' | 'clients' | null;
  changed_at: string | null;
}

export interface Bridge {
  id: number;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  host_key: string | null;
  has_ssh_password: boolean;
  has_ssh_key: boolean;
  country: string;
  status: BridgeStatus;
  installing: boolean;
  needs_apply: boolean;
  last_error: string | null;
  last_seen: string | null;
  created_at: string;
  links: BridgeLink[];
}

export interface BridgeInput {
  name?: string;
  host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_password?: string;
  ssh_key?: string;
  country?: string;
  links?: { server_id: number; mode: BridgeLinkMode }[];
}

export interface BridgeOperationResult {
  success: boolean;
  error?: string;
  log?: string;
  bridge: Bridge;
}

export type EventLevel = 'info' | 'warning' | 'error';
export interface PanelEvent {
  id: number;
  level: EventLevel;
  type: string;
  message: string;
  entity_kind: string | null;
  entity_id: string | null;
  created_at: string;
}
export interface EventsPage { items: PanelEvent[]; total: number }
export interface TelegramSettings {
  enabled: boolean;
  chat_id: string;
  bot_token_saved: boolean;
  notify_info: boolean;
}
export interface BackupSettings {
  enabled: boolean;
  provider: 'yandex' | 'google';
  interval_hours: number;
  retention: number;
  yandex_username: string;
  yandex_password_saved: boolean;
  google_client_id: string;
  google_client_secret_saved: boolean;
  google_refresh_token_saved: boolean;
  google_folder_id: string;
  last_run: string | null;
  last_error: string | null;
}
export interface RemoteBackup { id: string; name: string; created_at: string; size: number }
