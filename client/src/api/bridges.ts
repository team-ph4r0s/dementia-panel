import type {
  Bridge,
  BridgeInput,
  BridgeLinkMode,
  BridgeOperationResult,
  FailoverDnsCheck,
  FailoverInput,
  FailoverStatus,
  PanelPathCheck,
  ProbeCountry,
  ProbeSettings,
  ProbesOverview,
} from '../types';
import { API_BASE, json, request } from './client';

export const bridgesApi = {
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
};
