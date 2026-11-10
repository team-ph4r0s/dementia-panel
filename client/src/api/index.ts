import type {
  Server,
  ServerUpdate,
  NodeProtocol,
  Client,
  QrCodeData,
  Subscriber,
  AdminUser,
  SslStatus,
  Fail2banStatus,
  CloudflareZone,
  PanelSettings,
  SubscriptionSettings,
  DirectRouting,
  SubscriptionServer,
  ScanResult,
  Partner,
  PartnerClient,
  PartnerAuditEntry,
  RemotePanel,
  AmneziaImportResult,
  VersionInfo,
  PanelUpdateStatus,
  MigrationStatus,
  ProbeCountry,
  ProbeSettings,
  ProbesOverview,
  Bridge,
  BridgeInput,
  BridgeLinkMode,
  BridgeOperationResult,
  EventLevel,
  EventsPage,
  TelegramSettings,
  BackupSettings,
  RemoteBackup,
  GuestAccess,
  NodeUpdatesOverview,
  NodeUpdateSettings,
  CloudflarePanelStatus,
  CdnInput,
  FailoverInput,
  FailoverStatus,
  FailoverDnsCheck,
  PanelIpStatus,
  PanelIpApplyResult,
  PanelPathCheck,
} from '../types';

const API_BASE = '/api';

const TOKEN_KEY = 'dementia_token';
/** Ключ до переименования проекта (Demension, v0.1.3 и раньше) */
const LEGACY_TOKEN_KEY = 'demension_token';

export function getToken(): string | null {
  try {
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacy) {
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      if (!localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, legacy);
    }
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage недоступен (приватный режим) — сессия будет жить до перезагрузки страницы
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // ignore
  }
}

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options.headers || {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('auth_unauthorized'));
  }

  return res;
}

/**
 * Текст ошибки из ответа; переносит не-JSON ответы (HTML прокси, пустое тело)
 */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // не JSON
  }
  return `${fallback} (HTTP ${res.status})`;
}

async function request<T>(url: string, options: RequestInit, fallback: string): Promise<T> {
  const res = await fetchWithAuth(url, options);
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return res.json();
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const api = {
  getCloudflarePanel(): Promise<CloudflarePanelStatus> {
    return request(`${API_BASE}/security/cloudflare`, {}, 'Ошибка загрузки домена панели');
  },
  configureCloudflarePanel(input: { domain: string; token?: string; origin_ip?: string; email?: string; port: number }): Promise<CloudflarePanelStatus> {
    return request(`${API_BASE}/security/cloudflare`, { method: 'POST', ...json(input) }, 'Не удалось настроить домен панели');
  },
  disableCloudflarePanel(): Promise<CloudflarePanelStatus> {
    return request(`${API_BASE}/security/cloudflare`, { method: 'DELETE' }, 'Не удалось отключить проксирование');
  },
  getNodeUpdates(): Promise<NodeUpdatesOverview> {
    return request(`${API_BASE}/node-updates`, {}, 'Ошибка загрузки обновлений нод');
  },
  saveNodeUpdateSettings(settings: NodeUpdateSettings): Promise<NodeUpdateSettings> {
    return request(`${API_BASE}/node-updates`, { method: 'PUT', ...json(settings) }, 'Ошибка сохранения расписания');
  },
  startNodeUpdates(mode: 'check' | 'update', server_ids?: number[]): Promise<{ started: boolean }> {
    return request(`${API_BASE}/node-updates/${mode}`, { method: 'POST', ...json({ server_ids }) }, 'Не удалось запустить обслуживание нод');
  },
  // Auth
  async login(username: string, password: string, totp?: string, recoveryCode?: string): Promise<{ token: string; user: AdminUser } | { totp_required: true }> {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, totp, recovery_code: recoveryCode }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Ошибка входа'));
    const data = await res.json();
    if (data.token) setToken(data.token);
    return data;
  },

  me(): Promise<{ user: AdminUser }> {
    return request(`${API_BASE}/auth/me`, {}, 'Не авторизован');
  },

  async logout(): Promise<void> {
    await fetchWithAuth(`${API_BASE}/auth/logout`, { method: 'POST' }).catch(() => {});
    clearToken();
  },

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const data = await request<{ token?: string }>(
      `${API_BASE}/auth/change-password`,
      { method: 'POST', ...json({ oldPassword, newPassword }) },
      'Ошибка смены пароля'
    );
    // Сервер завершает все сессии и выдаёт новый токен текущему пользователю
    if (data.token) setToken(data.token);
  },

  /** Смена логина администратора: сервер завершает остальные сессии и выдаёт новый токен */
  async changeUsername(password: string, newUsername: string): Promise<AdminUser> {
    const data = await request<{ token?: string; user: AdminUser }>(
      `${API_BASE}/auth/change-username`,
      { method: 'POST', ...json({ password, newUsername }) },
      'Ошибка смены логина'
    );
    if (data.token) setToken(data.token);
    return data.user;
  },

  setupTotp(): Promise<{ secret: string; uri: string }> {
    return request(`${API_BASE}/auth/totp/setup`, { method: 'POST' }, 'Ошибка настройки 2FA');
  },

  enableTotp(secret: string, code: string, password: string): Promise<{ recovery_codes: string[] }> {
    return request(`${API_BASE}/auth/totp/enable`, { method: 'POST', ...json({ secret, code, password }) }, 'Ошибка включения 2FA');
  },

  disableTotp(password: string): Promise<void> {
    return request(`${API_BASE}/auth/totp/disable`, { method: 'POST', ...json({ password }) }, 'Ошибка отключения 2FA');
  },

  rotateRecoveryCodes(password: string): Promise<{ recovery_codes: string[] }> {
    return request(`${API_BASE}/auth/totp/recovery/rotate`, { method: 'POST', ...json({ password }) }, 'Ошибка перевыпуска кодов');
  },

  getGuestAccess(): Promise<GuestAccess> {
    return request(`${API_BASE}/auth/guest`, {}, 'Ошибка загрузки гостевого доступа');
  },

  saveGuestAccess(input: { enabled: boolean; username: string; password?: string; current_password: string }): Promise<GuestAccess> {
    return request(`${API_BASE}/auth/guest`, { method: 'PUT', ...json(input) }, 'Ошибка сохранения гостевого доступа');
  },

  async getSessions(): Promise<Array<{ id: number; ip: string; user_agent: string; last_activity: string; created_at: string; current: boolean; role?: 'admin' | 'guest' }>> {
    const data = await request<{ sessions: Array<{ id: number; ip: string; user_agent: string; last_activity: string; created_at: string; current: boolean; role?: 'admin' | 'guest' }> }>(`${API_BASE}/auth/sessions`, {}, 'Ошибка загрузки сессий');
    return data.sessions;
  },

  async revokeSession(id: number): Promise<void> {
    await request(`${API_BASE}/auth/sessions/${id}`, { method: 'DELETE' }, 'Ошибка завершения сессии');
  },

  // Servers
  getServers(): Promise<Server[]> {
    return request(`${API_BASE}/servers`, {}, 'Ошибка загрузки серверов');
  },

  getServer(id: number): Promise<Server> {
    return request(`${API_BASE}/servers/${id}`, {}, 'Ошибка загрузки сервера');
  },

  createServer(data: Partial<Server> & { ssh_password?: string; ssh_key?: string }): Promise<Server> {
    return request(`${API_BASE}/servers`, { method: 'POST', ...json(data) }, 'Ошибка добавления сервера');
  },

  updateServer(id: number, data: ServerUpdate): Promise<Server> {
    return request(`${API_BASE}/servers/${id}`, { method: 'PUT', ...json(data) }, 'Ошибка обновления сервера');
  },

  updateServerCountry(id: number, country: string | null): Promise<Server> {
    return request(`${API_BASE}/servers/${id}/country`, { method: 'PUT', ...json({ country }) }, 'Ошибка сохранения страны');
  },

  /** Запасные UDP-порты ноды AmneziaWG; на установленной ноде применяются сразу */
  updateServerExtraPorts(id: number, ports: number[]): Promise<Server> {
    return request(`${API_BASE}/servers/${id}/extra-ports`, { method: 'PUT', ...json({ ports }) }, 'Ошибка сохранения запасных портов');
  },

  async deleteServer(id: number, options: { teardown?: boolean; force?: boolean } = {}): Promise<void> {
    const params = new URLSearchParams();
    if (options.teardown) params.set('teardown', '1');
    if (options.force) params.set('force', '1');
    const query = params.toString() ? `?${params}` : '';
    await request(`${API_BASE}/servers/${id}${query}`, { method: 'DELETE' }, 'Ошибка удаления сервера');
  },

  testSsh(id: number): Promise<{ success: boolean; message?: string }> {
    return request(`${API_BASE}/servers/${id}/test-ssh`, { method: 'POST' }, 'Ошибка проверки SSH');
  },

  realityCandidates(id: number, domain?: string): Promise<{ candidates: { domain: string; latency_ms: number | null; suitable: boolean }[] }> {
    return request(
      `${API_BASE}/servers/${id}/reality-candidates`,
      { method: 'POST', ...json({ domain }) },
      'Ошибка проверки сайтов маскировки Reality'
    );
  },

  enableCdn(id: number, input: CdnInput): Promise<Server> {
    return request(`${API_BASE}/servers/${id}/cdn`, { method: 'POST', ...json(input) }, 'Не удалось включить вход через CDN');
  },

  disableCdn(id: number): Promise<Server & { warning?: string }> {
    return request(`${API_BASE}/servers/${id}/cdn`, { method: 'DELETE' }, 'Не удалось выключить вход через CDN');
  },

  randomizeParams(id: number): Promise<Server> {
    return request(`${API_BASE}/servers/${id}/randomize-params`, { method: 'POST' }, 'Ошибка рандомизации параметров');
  },

  /** Сигнатурный пакет I1 по пресету: quic и dns — для домена, stun — без него */
  awgSignature(preset: 'quic' | 'dns' | 'stun', domain: string): Promise<{ i1: string }> {
    return request(`${API_BASE}/servers/awg-signature`, { method: 'POST', ...json({ preset, domain }) }, 'Ошибка генерации пакета');
  },

  async syncServer(id: number): Promise<{ success: boolean; error?: string }> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${id}/sync`, { method: 'POST' });
    if (res.ok) return res.json();
    return { success: false, error: await errorMessage(res, 'Ошибка синхронизации') };
  },

  /**
   * Импорт серверов из AmneziaVPN по ключам полного доступа (vpn://…)
   */
  importAmneziaKeys(keys: string): Promise<{ results: AmneziaImportResult[] }> {
    return request(`${API_BASE}/servers/import-amnezia`, { method: 'POST', ...json({ keys }) }, 'Ошибка импорта из AmneziaVPN');
  },

  scanServer(id: number): Promise<ScanResult> {
    return request(`${API_BASE}/servers/${id}/scan`, { method: 'POST' }, 'Ошибка сканирования сервера');
  },

  async upgradeProtocol(id: number): Promise<{ success: boolean; error?: string; server: Server }> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${id}/upgrade-protocol`, { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (data?.server) return data;
    throw new Error(data?.error || `Ошибка перехода на новую версию протокола (HTTP ${res.status})`);
  },

  async applyServer(id: number): Promise<{ success: boolean; error?: string }> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${id}/apply`, { method: 'POST' });
    if (res.ok) return res.json();
    return { success: false, error: await errorMessage(res, 'Ошибка применения параметров') };
  },

  // Standalone Clients
  getClients(serverId: number): Promise<Client[]> {
    return request(`${API_BASE}/servers/${serverId}/clients`, {}, 'Ошибка загрузки клиентов');
  },

  createClient(serverId: number, name?: string): Promise<Client> {
    return request(`${API_BASE}/servers/${serverId}/clients`, { method: 'POST', ...json({ name }) }, 'Ошибка создания клиента');
  },

  updateClient(id: number, data: { name?: string; enabled?: number }): Promise<Client> {
    return request(`${API_BASE}/clients/${id}`, { method: 'PUT', ...json(data) }, 'Ошибка обновления клиента');
  },

  async deleteClient(id: number): Promise<void> {
    await request(`${API_BASE}/clients/${id}`, { method: 'DELETE' }, 'Ошибка удаления клиента');
  },

  getClientQr(id: number): Promise<QrCodeData> {
    return request(`${API_BASE}/clients/${id}/qrcode`, {}, 'Ошибка получения QR-кода');
  },

  /**
   * Скачивание конфигурации с заголовком Authorization (без токена в URL)
   */
  async downloadClientConfig(id: number, name: string, protocol: NodeProtocol = 'awg'): Promise<void> {
    const res = await fetchWithAuth(`${API_BASE}/clients/${id}/config`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Ошибка скачивания конфигурации'));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.${protocol === 'vless' ? 'txt' : 'conf'}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // Subscribers
  getSubscribers(): Promise<Subscriber[]> {
    return request(`${API_BASE}/subscribers`, {}, 'Ошибка загрузки подписчиков');
  },

  createSubscriber(data: { name: string; server_ids: number[]; traffic_limit?: number; expire_at?: string | null; country?: string | null }): Promise<Subscriber> {
    return request(`${API_BASE}/subscribers`, { method: 'POST', ...json(data) }, 'Ошибка создания пользователя');
  },

  updateSubscriber(
    id: number,
    data: { name?: string; enabled?: number; server_ids?: number[]; traffic_limit?: number; expire_at?: string | null; country?: string | null }
  ): Promise<Subscriber> {
    return request(`${API_BASE}/subscribers/${id}`, { method: 'PUT', ...json(data) }, 'Ошибка обновления пользователя');
  },

  async deleteSubscriber(id: number): Promise<void> {
    await request(`${API_BASE}/subscribers/${id}`, { method: 'DELETE' }, 'Ошибка удаления пользователя');
  },

  resetSubscriberToken(id: number): Promise<{ token: string }> {
    return request(`${API_BASE}/subscribers/${id}/reset-token`, { method: 'POST' }, 'Ошибка обновления токена');
  },

  resetSubscriberTraffic(id: number): Promise<Subscriber> {
    return request(`${API_BASE}/subscribers/${id}/reset-traffic`, { method: 'POST' }, 'Ошибка сброса трафика');
  },

  /**
   * Ссылка подписки: публичный адрес из настроек панели, иначе текущий origin
   */
  getSubscriptionUrl(token: string, publicUrl?: string | null): string {
    const origin = (publicUrl || window.location.origin).replace(/\/+$/, '');
    return `${origin}/sub/${token}`;
  },

  // Panel settings
  getSettings(): Promise<PanelSettings> {
    return request(`${API_BASE}/settings`, {}, 'Ошибка загрузки настроек');
  },

  getVersion(refresh = false): Promise<VersionInfo> {
    return request(`${API_BASE}/version${refresh ? '?refresh=1' : ''}`, {}, 'Ошибка проверки версии');
  },

  // Обновление панели из интерфейса (docs/releases.md)
  getPanelUpdate(): Promise<PanelUpdateStatus> {
    return request(`${API_BASE}/version/update`, {}, 'Ошибка получения состояния обновления');
  },

  startPanelUpdate(version: string): Promise<PanelUpdateStatus> {
    return request(`${API_BASE}/version/update`, { method: 'POST', ...json({ version }) }, 'Ошибка запуска обновления');
  },

  updateSettings(data: Partial<PanelSettings>): Promise<PanelSettings> {
    return request(`${API_BASE}/settings`, { method: 'PUT', ...json(data) }, 'Ошибка сохранения настроек');
  },

  // Subscription appearance (Incy headers, server names)
  getSubscriptionSettings(): Promise<{ settings: SubscriptionSettings; servers: SubscriptionServer[]; direct: DirectRouting }> {
    return request(`${API_BASE}/subscription-settings`, {}, 'Ошибка загрузки настроек подписки');
  },

  updateSubscriptionSettings(data: {
    settings?: Partial<SubscriptionSettings>;
    servers?: { id: number; sub_name: string; sub_order: number }[];
    direct?: { enabled: boolean; awg: boolean; countries: string[]; domains: string; cidrs: string };
  }): Promise<{
    settings: SubscriptionSettings;
    servers: SubscriptionServer[];
    direct: DirectRouting;
    refresh?: { country: string; error: string | null }[];
  }> {
    return request(`${API_BASE}/subscription-settings`, { method: 'PUT', ...json(data) }, 'Ошибка сохранения настроек подписки');
  },

  /** Скачать сети выбранных стран заново */
  refreshDirectCountries(countries?: string[]): Promise<{ results: { country: string; error: string | null }[]; direct: DirectRouting }> {
    return request(`${API_BASE}/subscription-settings/direct/refresh`, { method: 'POST', ...json({ countries }) }, 'Ошибка обновления сетей стран');
  },

  // Партнёрский доступ: выданные доступы к своим нодам
  getPartners(): Promise<Partner[]> {
    return request(`${API_BASE}/partners`, {}, 'Ошибка загрузки партнёров');
  },

  createPartner(data: {
    name: string;
    node_ids: number[];
    max_clients: number;
    traffic_limit: number;
    expire_at: string | null;
  }): Promise<{ partner: Partner; token: string; connect_string: string }> {
    return request(`${API_BASE}/partners`, { method: 'POST', ...json(data) }, 'Ошибка создания доступа');
  },

  updatePartner(
    id: number,
    data: Partial<{ name: string; node_ids: number[]; max_clients: number; traffic_limit: number; expire_at: string | null; enabled: boolean }>
  ): Promise<Partner> {
    return request(`${API_BASE}/partners/${id}`, { method: 'PUT', ...json(data) }, 'Ошибка обновления доступа');
  },

  regeneratePartnerToken(id: number): Promise<{ partner: Partner; token: string; connect_string: string }> {
    return request(`${API_BASE}/partners/${id}/regenerate-token`, { method: 'POST' }, 'Ошибка перевыпуска токена');
  },

  async deletePartner(id: number): Promise<void> {
    await request(`${API_BASE}/partners/${id}`, { method: 'DELETE' }, 'Ошибка удаления доступа');
  },

  getPartnerClients(id: number): Promise<PartnerClient[]> {
    return request(`${API_BASE}/partners/${id}/clients`, {}, 'Ошибка загрузки клиентов партнёра');
  },

  getPartnerAudit(id: number): Promise<PartnerAuditEntry[]> {
    return request(`${API_BASE}/partners/${id}/audit`, {}, 'Ошибка загрузки журнала');
  },

  // Партнёрский доступ: подключённые панели партнёров
  getRemotePanels(): Promise<RemotePanel[]> {
    return request(`${API_BASE}/remote-panels`, {}, 'Ошибка загрузки панелей партнёров');
  },

  connectRemotePanel(connectString: string, name?: string): Promise<RemotePanel> {
    return request(`${API_BASE}/remote-panels`, { method: 'POST', ...json({ connect_string: connectString, name }) }, 'Ошибка подключения панели');
  },

  syncRemotePanel(id: number): Promise<RemotePanel> {
    return request(`${API_BASE}/remote-panels/${id}/sync`, { method: 'POST' }, 'Ошибка синхронизации');
  },

  disconnectRemotePanel(id: number): Promise<{ success: boolean; remoteCleanup: boolean }> {
    return request(`${API_BASE}/remote-panels/${id}`, { method: 'DELETE' }, 'Ошибка отключения панели');
  },

  // Проверка доступности нод из стран
  getProbes(): Promise<ProbesOverview> {
    return request(`${API_BASE}/probes`, {}, 'Ошибка загрузки проверок доступности');
  },

  getProbeCountries(): Promise<ProbeCountry[]> {
    return request(`${API_BASE}/probes/countries`, {}, 'Ошибка получения списка стран');
  },

  updateProbes(data: {
    settings?: Partial<ProbeSettings>;
    servers?: { id: number; probe_port: number | null }[];
  }): Promise<ProbesOverview> {
    return request(`${API_BASE}/probes`, { method: 'PUT', ...json(data) }, 'Ошибка сохранения настроек проверки');
  },

  async runProbes(): Promise<void> {
    await request(`${API_BASE}/probes/run`, { method: 'POST' }, 'Ошибка запуска проверки');
  },

  // Мосты в странах пользователей
  getFailover(): Promise<FailoverStatus> {
    return request(`${API_BASE}/bridges/failover`, {}, 'Ошибка загрузки резервного домена');
  },

  configureFailover(input: FailoverInput): Promise<FailoverStatus> {
    return request(`${API_BASE}/bridges/failover`, { method: 'POST', ...json(input) }, 'Не удалось настроить резервный домен');
  },

  disableFailover(): Promise<FailoverStatus> {
    return request(`${API_BASE}/bridges/failover`, { method: 'DELETE' }, 'Не удалось выключить резервный домен');
  },

  getPanelIp(): Promise<PanelIpStatus> {
    return request(`${API_BASE}/security/panel-ip`, {}, 'Ошибка загрузки IP панели');
  },

  applyPanelIp(ip: string): Promise<PanelIpApplyResult> {
    return request(`${API_BASE}/security/panel-ip`, { method: 'POST', ...json({ ip }) }, 'Не удалось обновить IP панели');
  },

  setPanelIpAuto(auto: boolean): Promise<PanelIpStatus> {
    return request(`${API_BASE}/security/panel-ip/auto`, { method: 'PUT', ...json({ auto }) }, 'Не удалось сохранить настройку');
  },

  checkFailoverDns(): Promise<FailoverDnsCheck> {
    return request(`${API_BASE}/bridges/failover/check-dns`, { method: 'POST' }, 'Не удалось проверить DNS');
  },

  checkBridgePanelPath(id: number): Promise<PanelPathCheck> {
    return request(`${API_BASE}/bridges/${id}/panel-check`, { method: 'POST' }, 'Не удалось проверить путь к панели');
  },

  getBridges(): Promise<Bridge[]> {
    return request(`${API_BASE}/bridges`, {}, 'Ошибка загрузки мостов');
  },

  /** Добавление сразу устанавливает мост: ответ приходит после установки (с журналом) */
  createBridge(data: BridgeInput): Promise<BridgeOperationResult> {
    return request(`${API_BASE}/bridges`, { method: 'POST', ...json(data) }, 'Ошибка добавления моста');
  },

  updateBridge(id: number, data: BridgeInput): Promise<Bridge> {
    return request(`${API_BASE}/bridges/${id}`, { method: 'PUT', ...json(data) }, 'Ошибка сохранения моста');
  },

  setBridgeLinks(id: number, links: { server_id: number; mode: BridgeLinkMode }[]): Promise<BridgeOperationResult> {
    return request(`${API_BASE}/bridges/${id}/links`, { method: 'PUT', ...json({ links }) }, 'Ошибка привязки нод к мосту');
  },

  /** sni — сайт маскировки Reality для нового каскада; без него панель выберет сама */
  setBridgeCascade(id: number, serverId: number, port: number | 'auto' | null, sni?: string): Promise<BridgeOperationResult> {
    return request(`${API_BASE}/bridges/${id}/links/${serverId}/cascade`, { method: 'PUT', ...json({ port, ...(sni ? { sni } : {}) }) }, 'Ошибка настройки каскада');
  },

  installBridge(id: number): Promise<BridgeOperationResult> {
    return request(`${API_BASE}/bridges/${id}/install`, { method: 'POST' }, 'Ошибка установки моста');
  },

  testBridgeSsh(id: number): Promise<{ success: boolean; message?: string }> {
    return request(`${API_BASE}/bridges/${id}/test-ssh`, { method: 'POST' }, 'Ошибка проверки SSH');
  },

  deleteBridge(id: number, opts: { teardown?: boolean; force?: boolean } = {}): Promise<{ success: boolean }> {
    const query = new URLSearchParams();
    if (opts.teardown) query.set('teardown', '1');
    if (opts.force) query.set('force', '1');
    const qs = query.toString();
    return request(`${API_BASE}/bridges/${id}${qs ? `?${qs}` : ''}`, { method: 'DELETE' }, 'Ошибка удаления моста');
  },

  // Перенос панели на другой сервер
  getMigrationStatus(): Promise<MigrationStatus> {
    return request(`${API_BASE}/migration/status`, {}, 'Ошибка получения состояния переноса');
  },

  /** Код переноса показывается один раз: сервер хранит только производные от него значения */
  prepareMigration(password: string): Promise<{ code: string; expiresAt: string }> {
    return request(`${API_BASE}/migration/prepare`, { method: 'POST', ...json({ password }) }, 'Ошибка подготовки переноса');
  },

  async cancelMigration(): Promise<void> {
    await request(`${API_BASE}/migration/cancel`, { method: 'POST' }, 'Ошибка отмены переноса');
  },

  /** Архив переноса файлом (если новому серверу недоступен адрес этой панели): fetch с токеном в заголовке, затем Blob */
  async downloadMigrationArchive(): Promise<void> {
    const res = await fetchWithAuth(`${API_BASE}/migration/download`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Ошибка скачивания архива'));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dementia-migration-${new Date().toISOString().slice(0, 10)}.dpm`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // Security: SSL & Fail2ban
  getSslStatus(): Promise<SslStatus> {
    return request(`${API_BASE}/security/ssl`, {}, 'Ошибка получения статуса SSL');
  },

  verifyCloudflareToken(token: string): Promise<{ valid: boolean; message: string }> {
    return request(`${API_BASE}/security/ssl/verify-cf`, { method: 'POST', ...json({ token }) }, 'Ошибка верификации Cloudflare');
  },

  getCloudflareZones(token: string): Promise<CloudflareZone[]> {
    return request(`${API_BASE}/security/ssl/cf-zones`, { method: 'POST', ...json({ token }) }, 'Ошибка загрузки зон Cloudflare');
  },

  issueLetsEncryptCf(data: { domain: string; email: string; token: string; createARecord: boolean }): Promise<{ success: boolean }> {
    return request(`${API_BASE}/security/ssl/issue-cf`, { method: 'POST', ...json(data) }, 'Ошибка выпуска сертификата через Cloudflare');
  },

  issueLetsEncryptHttp(data: { domain: string; email: string }): Promise<{ success: boolean }> {
    return request(`${API_BASE}/security/ssl/issue-http`, { method: 'POST', ...json(data) }, 'Ошибка выпуска сертификата через HTTP-01');
  },

  issueSelfSignedIp(ip: string): Promise<{ success: boolean }> {
    return request(`${API_BASE}/security/ssl/issue-ip`, { method: 'POST', ...json({ ip }) }, 'Ошибка генерации IP-сертификата');
  },

  saveCustomCert(data: { cert: string; key: string; domain?: string }): Promise<{ success: boolean }> {
    return request(`${API_BASE}/security/ssl/custom`, { method: 'POST', ...json(data) }, 'Ошибка сохранения сертификата');
  },

  toggleSsl(enabled: boolean): Promise<{ success: boolean; enabled: boolean }> {
    return request(`${API_BASE}/security/ssl/toggle`, { method: 'POST', ...json({ enabled }) }, 'Ошибка переключения SSL');
  },

  getFail2banStatus(): Promise<Fail2banStatus> {
    return request(`${API_BASE}/security/fail2ban`, {}, 'Ошибка загрузки статуса Fail2ban');
  },

  unbanIp(ip: string): Promise<{ success: boolean; message: string }> {
    return request(`${API_BASE}/security/fail2ban/unban`, { method: 'POST', ...json({ ip }) }, 'Ошибка разблокировки IP');
  },

  banIp(ip: string): Promise<{ success: boolean; message: string }> {
    return request(`${API_BASE}/security/fail2ban/ban`, { method: 'POST', ...json({ ip }) }, 'Ошибка блокировки IP');
  },

  setupFail2ban(): Promise<{ success: boolean; message: string }> {
    return request(`${API_BASE}/security/fail2ban/setup`, { method: 'POST' }, 'Ошибка установки Fail2ban');
  },

  getEvents(options: { level?: EventLevel; limit?: number; offset?: number } = {}): Promise<EventsPage> {
    const params = new URLSearchParams();
    if (options.level) params.set('level', options.level);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    return request(`${API_BASE}/events?${params}`, {}, 'Ошибка загрузки событий');
  },

  async getTelegramSettings(): Promise<TelegramSettings> {
    const data = await request<{ settings: TelegramSettings }>(`${API_BASE}/telegram`, {}, 'Ошибка загрузки Telegram');
    return data.settings;
  },

  async updateTelegramSettings(data: Omit<TelegramSettings, 'bot_token_saved'> & { bot_token?: string }): Promise<TelegramSettings> {
    const result = await request<{ settings: TelegramSettings }>(`${API_BASE}/telegram`, { method: 'PUT', ...json(data) }, 'Ошибка сохранения Telegram');
    return result.settings;
  },

  testTelegram(data?: { bot_token?: string; chat_id?: string }): Promise<{ success: boolean; message: string }> {
    return request(`${API_BASE}/telegram/test`, { method: 'POST', ...(data ? json(data) : {}) }, 'Ошибка проверки Telegram');
  },

  detectTelegramChat(data?: { bot_token?: string }): Promise<{ success: boolean; chat_id?: string; name?: string; message: string }> {
    return request(`${API_BASE}/telegram/detect-chat`, { method: 'POST', ...(data ? json(data) : {}) }, 'Ошибка определения чата Telegram');
  },

  async getBackupSettings(): Promise<BackupSettings> {
    return (await request<{ settings: BackupSettings }>(`${API_BASE}/backups/settings`, {}, 'Ошибка загрузки настроек копий')).settings;
  },
  async updateBackupSettings(data: Partial<BackupSettings> & { yandex_password?: string; google_client_secret?: string; google_refresh_token?: string }): Promise<BackupSettings> {
    return (await request<{ settings: BackupSettings }>(`${API_BASE}/backups/settings`, { method: 'PUT', ...json(data) }, 'Ошибка сохранения настроек копий')).settings;
  },
  testBackups(): Promise<{ success: boolean; message: string }> {
    return request(`${API_BASE}/backups/test`, { method: 'POST' }, 'Ошибка проверки хранилища');
  },
  runBackup(): Promise<{ success: boolean; error?: string }> {
    return request(`${API_BASE}/backups/run`, { method: 'POST' }, 'Ошибка создания копии');
  },
  getBackups(): Promise<{ backups: RemoteBackup[] }> {
    return request(`${API_BASE}/backups`, {}, 'Ошибка загрузки списка копий');
  },
  async downloadBackup(id: string, name: string): Promise<void> {
    const res = await fetchWithAuth(`${API_BASE}/backups/${encodeURIComponent(id)}/download`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Ошибка скачивания копии'));
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    URL.revokeObjectURL(url);
  },
  async deleteBackup(id: string): Promise<void> {
    await request(`${API_BASE}/backups/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Ошибка удаления копии');
  },
  getBackupRecoveryKey(password: string): Promise<{ recovery_key: string }> {
    return request(`${API_BASE}/backups/recovery-key`, { method: 'POST', ...json({ password }) }, 'Ошибка получения ключа');
  },
};
