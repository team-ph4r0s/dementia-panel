import type { DirectRouting, Subscriber, SubscriptionServer, SubscriptionSettings } from '../types';
import { API_BASE, json, request } from './client';

export const subscribersApi = {
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
};
