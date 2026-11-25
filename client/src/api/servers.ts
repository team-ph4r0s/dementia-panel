import type {
  AmneziaImportResult,
  CdnInput,
  Client,
  NodeProtocol,
  NodeUpdateSettings,
  NodeUpdatesOverview,
  QrCodeData,
  ScanResult,
  Server,
  ServerUpdate,
} from '../types';
import { API_BASE, errorMessage, fetchWithAuth, json, request } from './client';

export const serversApi = {
  getNodeUpdates(): Promise<NodeUpdatesOverview> {
    return request(`${API_BASE}/node-updates`, {}, 'Ошибка загрузки обновлений нод');
  },
  saveNodeUpdateSettings(settings: NodeUpdateSettings): Promise<NodeUpdateSettings> {
    return request(`${API_BASE}/node-updates`, { method: 'PUT', ...json(settings) }, 'Ошибка сохранения расписания');
  },
  startNodeUpdates(mode: 'check' | 'update', server_ids?: number[]): Promise<{ started: boolean }> {
    return request(`${API_BASE}/node-updates/${mode}`, { method: 'POST', ...json({ server_ids }) }, 'Не удалось запустить обслуживание нод');
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
};
