import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useLiveUpdates } from '../live';
import type { AdminUser, Bridge, Client, MigrationStatus, Server, Subscriber } from '../types';

interface UsePanelDataOptions {
  user: AdminUser | null;
  isGuest: boolean;
}

export function usePanelData({ user, isGuest }: UsePanelDataOptions) {
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  // База ссылок подписок: резервный домен (через мосты), если включён, иначе публичный адрес панели
  const [subscriptionUrl, setSubscriptionUrl] = useState<string | null>(null);
  const subscriptionBase = subscriptionUrl || publicUrl;
  // Обнаруженная смена IP панели (PanelAddressService): домен и мосты ведут на старый адрес, пока его не обновят
  const [panelIpChange, setPanelIpChange] = useState<{ known: string | null; detected: string | null } | null>(null);
  // Номер последнего запроса клиентов: ответ для ранее выбранного сервера отбрасывается
  const clientsRequestRef = useRef(0);
  const dataInFlightRef = useRef(false);
  const pendingRefreshRef = useRef<{ full: boolean; scopes: Set<string> } | null>(null);
  const [migrationState, setMigrationState] = useState<MigrationStatus['state']>('idle');

  const loadData = async (scopes?: Set<string>) => {
    if (!user) return;
    if (dataInFlightRef.current) {
      const pending = pendingRefreshRef.current ?? { full: false, scopes: new Set<string>() };
      if (!scopes) {
        pending.full = true;
      } else if (!pending.full) {
        for (const s of scopes) pending.scopes.add(s);
      }
      pendingRefreshRef.current = pending;
      return;
    }
    dataInFlightRef.current = true;
    try {
      const needFull = !scopes || scopes.has('other');
      const needServers = needFull || scopes.has('servers') || scopes.has('clients') || scopes.has('bridges');
      const needSubscribers = needFull || scopes.has('subscribers') || scopes.has('clients');
      const needBridges = needFull || scopes.has('bridges');
      const needSettings = needFull || scopes.has('settings') || scopes.has('security');
      const needMigration = !isGuest && (needFull || scopes.has('migration'));
      const needPanelIp = !isGuest && (needFull || scopes.has('security'));

      const [serversData, subscribersData, bridgesData, settings, migration, panelIp] = await Promise.all([
        needServers ? api.getServers() : Promise.resolve(null),
        needSubscribers ? api.getSubscribers() : Promise.resolve(null),
        needBridges ? api.getBridges().catch(() => null) : Promise.resolve(null),
        needSettings ? api.getSettings().catch(() => null) : Promise.resolve(null),
        needMigration ? api.getMigrationStatus().catch(() => null) : Promise.resolve(null),
        needPanelIp ? api.getPanelIp().catch(() => null) : Promise.resolve(null),
      ]);
      if (migration) setMigrationState(migration.state);
      if (needPanelIp) setPanelIpChange(panelIp?.changed ? { known: panelIp.known, detected: panelIp.detected } : null);
      if (serversData) {
        setServers(serversData);
        setSelectedServerId((current) =>
          current !== null && serversData.some((s) => s.id === current) ? current : serversData[0]?.id ?? null
        );
      }
      if (subscribersData) setSubscribers(subscribersData);
      if (bridgesData) setBridges(bridgesData);
      if (settings) {
        setPublicUrl(settings.public_url || null);
        setSubscriptionUrl(settings.subscription_url || null);
      }
      setOffline(false);
    } catch (err) {
      console.error('Ошибка загрузки данных:', err);
      setOffline(true);
    } finally {
      dataInFlightRef.current = false;
      setLoading(false);
      const pending = pendingRefreshRef.current;
      if (pending) {
        pendingRefreshRef.current = null;
        void loadersRef.current.loadData(pending.full ? undefined : pending.scopes);
      }
    }
  };

  const loadClients = async (serverId: number) => {
    const requestId = ++clientsRequestRef.current;
    try {
      const data = await api.getClients(serverId);
      if (requestId === clientsRequestRef.current) setClients(data);
    } catch (err) {
      console.error('Ошибка загрузки клиентов:', err);
    }
  };

  const loadersRef = useRef({ loadData, loadClients });
  useEffect(() => {
    loadersRef.current = { loadData, loadClients };
  });

  useEffect(() => {
    if (user) {
      loadersRef.current.loadData();
    }
  }, [user]);

  useEffect(() => {
    if (selectedServerId !== null && user) {
      loadersRef.current.loadClients(selectedServerId);
    }
  }, [selectedServerId, user]);

  // Живые обновления по WebSocket (гостю сокет не нужен: он опрашивает API); при обрыве работает прежний опрос
  const refresh = (scopes?: string[]) => {
    if (document.hidden) return;
    const scopeSet = scopes?.length ? new Set(scopes) : undefined;
    loadersRef.current.loadData(scopeSet);
    const needClients = !scopeSet || scopeSet.has('clients') || scopeSet.has('servers') || scopeSet.has('subscribers') || scopeSet.has('other');
    if (selectedServerId !== null && needClients) loadersRef.current.loadClients(selectedServerId);
  };
  const live = useLiveUpdates(Boolean(user) && !isGuest, refresh);

  // Вернулась сеть (телефон вышел из метро или проснулся) — не ждём очередного опроса
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    if (!user) return;
    const onOnline = () => refreshRef.current();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [user]);

  // Периодический опрос: раз в 15 секунд, а пока сокет жив — лишь как страховка раз в минуту
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadersRef.current.loadData();
      if (selectedServerId !== null) {
        loadersRef.current.loadClients(selectedServerId);
      }
    }, live ? 60000 : 15000);
    return () => clearInterval(interval);
  }, [selectedServerId, user, live]);

  return {
    servers,
    setServers,
    selectedServerId,
    setSelectedServerId,
    clients,
    setClients,
    subscribers,
    setSubscribers,
    bridges,
    loading,
    offline,
    publicUrl,
    setPublicUrl,
    subscriptionUrl,
    setSubscriptionUrl,
    subscriptionBase,
    panelIpChange,
    migrationState,
    live,
    loadData,
  };
}
