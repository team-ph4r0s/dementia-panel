import type {
  AdminUser,
  BackupSettings,
  CloudflarePanelStatus,
  CloudflareZone,
  EventLevel,
  EventsPage,
  Fail2banStatus,
  GuestAccess,
  MigrationStatus,
  PanelIpApplyResult,
  PanelIpStatus,
  PanelSettings,
  PanelUpdateStatus,
  Partner,
  PartnerAuditEntry,
  PartnerClient,
  ProviderInput,
  ProviderItem,
  ProviderSettings,
  ProviderTargetType,
  ProvidersData,
  RemoteBackup,
  RemotePanel,
  SslStatus,
  TelegramSettings,
  VersionInfo,
} from '../types';
import { API_BASE, clearToken, errorMessage, fetchWithAuth, json, request, setToken } from './client';

export const adminApi = {
  getCloudflarePanel(): Promise<CloudflarePanelStatus> {
    return request(`${API_BASE}/security/cloudflare`, {}, 'Ошибка загрузки домена панели');
  },
  configureCloudflarePanel(input: { domain: string; token?: string; origin_ip?: string; email?: string; port: number }): Promise<CloudflarePanelStatus> {
    return request(`${API_BASE}/security/cloudflare`, { method: 'POST', ...json(input) }, 'Не удалось настроить домен панели');
  },
  disableCloudflarePanel(): Promise<CloudflarePanelStatus> {
    return request(`${API_BASE}/security/cloudflare`, { method: 'DELETE' }, 'Не удалось отключить проксирование');
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

  // Panel settings & version
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

  getPanelIp(): Promise<PanelIpStatus> {
    return request(`${API_BASE}/security/panel-ip`, {}, 'Ошибка загрузки IP панели');
  },

  applyPanelIp(ip: string): Promise<PanelIpApplyResult> {
    return request(`${API_BASE}/security/panel-ip`, { method: 'POST', ...json({ ip }) }, 'Не удалось обновить IP панели');
  },

  setPanelIpAuto(auto: boolean): Promise<PanelIpStatus> {
    return request(`${API_BASE}/security/panel-ip/auto`, { method: 'PUT', ...json({ auto }) }, 'Не удалось сохранить настройку');
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

  getProviders(): Promise<ProvidersData> {
    return request(`${API_BASE}/providers`, {}, 'Ошибка загрузки провайдеров');
  },

  async saveProvider(type: ProviderTargetType, id: number, data: ProviderInput): Promise<ProviderItem[]> {
    const body = {
      url: data.url, login: data.login, amount: data.amount, currency: data.currency,
      pay_day: data.pay_day, pay_month: data.pay_month,
      ...(data.password !== undefined ? { password: data.password } : {}),
    };
    return (await request<{ items: ProviderItem[] }>(`${API_BASE}/providers/${type}/${id}`, { method: 'PUT', ...json(body) }, 'Ошибка сохранения данных провайдера')).items;
  },

  async getProviderPassword(type: ProviderTargetType, id: number): Promise<string> {
    return (await request<{ password: string }>(`${API_BASE}/providers/${type}/${id}/password`, {}, 'Не удалось получить пароль')).password;
  },

  async saveProviderSettings(data: ProviderSettings): Promise<ProviderSettings> {
    return (await request<{ settings: ProviderSettings }>(`${API_BASE}/providers/settings`, { method: 'PUT', ...json(data) }, 'Ошибка сохранения напоминаний')).settings;
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
