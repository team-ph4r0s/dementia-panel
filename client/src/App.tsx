import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Navbar, type AppTab } from './components/Navbar';
import { ServersView } from './components/ServersView';
import { AddServerModal } from './components/AddServerModal';
import { InstallLogsModal } from './components/InstallLogsModal';
import { AwgParamsModal } from './components/AwgParamsModal';
import { VlessParamsModal } from './components/VlessParamsModal';
import { AddClientModal } from './components/AddClientModal';
import { AddSubscriberModal } from './components/AddSubscriberModal';
import { SubscriptionModal } from './components/SubscriptionModal';
import { AccountModal } from './components/AccountModal';
import { QrCodeModal } from './components/QrCodeModal';
import { LoginView } from './components/LoginView';
import { useGuestLock } from './guestLock';
import { useFeedback } from './components/ui/feedback-context';
import { useLiveUpdates } from './live';
import type { Server, Client, Subscriber, Bridge, QrCodeData, AdminUser, MigrationStatus } from './types';
import { api, getToken } from './api';
import { ShieldCheck, Plus, Terminal, Zap, Sparkles, AlertTriangle, Eye, WifiOff } from 'lucide-react';
import { ConnectionLost } from './components/ConnectionLost';

const SubscriptionSettingsView = React.lazy(() => import('./components/SubscriptionSettingsView').then((m) => ({ default: m.SubscriptionSettingsView })));
const PartnersView = React.lazy(() => import('./components/PartnersView').then((m) => ({ default: m.PartnersView })));
const BridgesView = React.lazy(() => import('./components/BridgesView').then((m) => ({ default: m.BridgesView })));
const SubscribersList = React.lazy(() => import('./components/SubscribersList').then((m) => ({ default: m.SubscribersList })));
const SecurityView = React.lazy(() => import('./components/SecurityView').then((m) => ({ default: m.SecurityView })));
const ProvidersView = React.lazy(() => import('./components/ProvidersView').then((m) => ({ default: m.ProvidersView })));
const EventsView = React.lazy(() => import('./components/EventsView').then((m) => ({ default: m.EventsView })));
const DocumentationView = React.lazy(() => import('./components/DocumentationView').then((m) => ({ default: m.DocumentationView })));

type Session = { kind: 'user'; user: AdminUser } | { kind: 'lost' } | { kind: 'anonymous' };

/** Проверка сессии: 401 стирает токен (api/index.ts), поэтому «токен остался» значит, что запрос не дошёл до панели (сеть, перезапуск) */
async function resolveSession(): Promise<Session> {
  try {
    const res = await api.me();
    return { kind: 'user', user: res.user };
  } catch {
    return getToken() ? { kind: 'lost' } : { kind: 'anonymous' };
  }
}

export const App: React.FC = () => {
  const { toast, alert: showAlert } = useFeedback();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  // Сессия есть, но сервер недоступен (сеть, перезапуск панели): не показываем форму входа и не стираем токен
  const [connectionLost, setConnectionLost] = useState(false);
  // Уже вошли, но обновление данных не удаётся: остаются последние полученные данные и баннер
  const [offline, setOffline] = useState(false);

  const [activeTab, setActiveTab] = useState<AppTab>('servers');
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals state
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const [installModalServer, setInstallModalServer] = useState<Server | null>(null);
  const [paramsModalServer, setParamsModalServer] = useState<Server | null>(null);
  const [isAddClientOpen, setIsAddClientOpen] = useState(false);
  const [qrModalClientId, setQrModalClientId] = useState<number | null>(null);
  const [qrData, setQrData] = useState<QrCodeData | null>(null);

  // Subscriber modals
  const [isAddSubscriberOpen, setIsAddSubscriberOpen] = useState(false);
  const [editingSubscriber, setEditingSubscriber] = useState<Subscriber | null>(null);
  const [subscriptionModalSubId, setSubscriptionModalSubId] = useState<number | null>(null);
  const [editingServer, setEditingServer] = useState<Server | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  // База ссылок подписок: резервный домен (через мосты), если включён, иначе публичный адрес панели
  const [subscriptionUrl, setSubscriptionUrl] = useState<string | null>(null);
  const subscriptionBase = subscriptionUrl || publicUrl;
  // Обнаруженная смена IP панели (PanelAddressService): домен и мосты ведут на старый адрес, пока его не обновят
  const [panelIpChange, setPanelIpChange] = useState<{ known: string | null; detected: string | null } | null>(null);
  // Номер последнего запроса клиентов: ответ для ранее выбранного сервера отбрасывается
  const clientsRequestRef = useRef(0);
  const dataInFlightRef = useRef(false);
  const settingsLoadedRef = useRef(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [migrationState, setMigrationState] = useState<MigrationStatus['state']>('idle');
  // Гость видит панель, но не меняет её: кнопки и поля внутри <main> блокируются (сервер всё равно отклонит запись)
  const isGuest = user?.role === 'guest';
  const mainRef = useRef<HTMLElement>(null);
  useGuestLock(isGuest, mainRef);

  // Результат проверки применяется отдельно от самой проверки: состояние меняется только в ответе, а не в теле эффекта
  const applySession = useCallback((session: Session) => {
    if (session.kind === 'user') setUser(session.user);
    else if (session.kind === 'anonymous') setUser(null);
    setConnectionLost(session.kind === 'lost');
    setAuthChecking(false);
  }, []);
  const checkAuth = useCallback(() => resolveSession().then(applySession), [applySession]);

  useEffect(() => {
    checkAuth();

    const handleUnauthorized = () => {
      setUser(null);
    };
    window.addEventListener('auth_unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth_unauthorized', handleUnauthorized);
  }, [checkAuth]);

  const loadData = async () => {
    if (!user || dataInFlightRef.current) return;
    dataInFlightRef.current = true;
    try {
      const [serversData, subscribersData, bridgesData, settings, migration, panelIp] = await Promise.all([
        api.getServers(),
        api.getSubscribers(),
        api.getBridges().catch(() => null),
        settingsLoadedRef.current ? Promise.resolve(null) : api.getSettings().catch(() => null),
        isGuest ? Promise.resolve(null) : api.getMigrationStatus().catch(() => null),
        isGuest ? Promise.resolve(null) : api.getPanelIp().catch(() => null),
      ]);
      if (migration) setMigrationState(migration.state);
      setPanelIpChange(panelIp?.changed ? { known: panelIp.known, detected: panelIp.detected } : null);
      setServers(serversData);
      setSubscribers(subscribersData);
      if (bridgesData) setBridges(bridgesData);
      if (settings) {
        settingsLoadedRef.current = true;
        setPublicUrl(settings.public_url || null);
        setSubscriptionUrl(settings.subscription_url || null);
      }
      setSelectedServerId((current) =>
        current !== null && serversData.some((s) => s.id === current) ? current : serversData[0]?.id ?? null
      );
      setOffline(false);
    } catch (err) {
      console.error('Ошибка загрузки данных:', err);
      setOffline(true);
    } finally {
      dataInFlightRef.current = false;
      setLoading(false);
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
  const refresh = () => {
    if (document.hidden) return;
    loadersRef.current.loadData();
    if (selectedServerId !== null) loadersRef.current.loadClients(selectedServerId);
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

  if (authChecking) {
    return (
      <div className="min-h-dvh bg-page flex items-center justify-center text-faint text-sm">
        Загрузка панели...
      </div>
    );
  }

  if (connectionLost) {
    return <ConnectionLost onRetry={checkAuth} />;
  }

  if (!user) {
    return <LoginView onLoginSuccess={(loggedInUser) => setUser(loggedInUser)} />;
  }

  const selectedServer = servers.find((s) => s.id === selectedServerId) || null;
  const subscriptionModalSub = subscribers.find((s) => s.id === subscriptionModalSubId) || null;

  // Перед установкой сервер сканируется: если AmneziaWG уже стоит (панели или приложения Amnezia),
  // он подключается без переустановки
  const handleServerAdded = async (newServer: Server) => {
    setServers((prev) => [newServer, ...prev]);
    setSelectedServerId(newServer.id);
    if (newServer.protocol === 'vless') {
      setInstallModalServer(newServer);
      return;
    }
    try {
      const scan = await api.scanServer(newServer.id);
      if (scan.found) {
        handleServerUpdated(scan.server);
        loadData();
        const amneziaNote =
          scan.adopted?.managedBy === 'amnezia'
            ? '\n\nЭто контейнер приложения Amnezia: не меняйте клиентов этого сервера в приложении Amnezia — панель перезапишет конфигурацию.'
            : '';
        await showAlert(scan.message + amneziaNote, 'Нода подключена');
        return;
      }
    } catch (err: any) {
      await showAlert(`Не удалось просканировать сервер: ${err.message}\n\nПроверьте SSH-доступ («Тест SSH») и запустите установку вручную.`, 'Сканирование не удалось');
      return;
    }
    setInstallModalServer(newServer);
  };

  const handleShowQr = async (clientId: number) => {
    try {
      const data = await api.getClientQr(clientId);
      setQrData(data);
      setQrModalClientId(clientId);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const handleClientAdded = (newClient: Client) => {
    setClients((prev) => [newClient, ...prev]);
    setServers((prev) =>
      prev.map((s) =>
        s.id === newClient.server_id
          ? { ...s, client_count: (s.client_count || 0) + 1, active_client_count: (s.active_client_count || 0) + 1 }
          : s
      )
    );
    // Конфигурации ещё нет, пока панель владельца не выдала IP клиенту на ноде партнёра (сервер ответил бы 409)
    if (!newClient.pending && !newClient.external && !newClient.partner_id) handleShowQr(newClient.id);
  };

  const handleClientUpdated = (updated: Client) => {
    setClients((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const handleClientDeleted = (clientId: number) => {
    setClients((prev) => prev.filter((c) => c.id !== clientId));
    setServers((prev) =>
      prev.map((s) =>
        s.id === selectedServerId
          ? { ...s, client_count: Math.max(0, (s.client_count || 1) - 1) }
          : s
      )
    );
  };

  const handleServerDeleted = (id: number) => {
    const remaining = servers.filter((s) => s.id !== id);
    setServers(remaining);
    setSelectedServerId(remaining.length > 0 ? remaining[0].id : null);
    // Клиенты удалённого сервера пропали и из подписок
    loadData();
  };

  const handleServerUpdated = (updated: Server) => {
    setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  };

  return (
    <div className="min-h-dvh bg-page text-ink flex flex-col font-sans selection:bg-ok-soft selection:text-ok">
      <Navbar
        servers={servers}
        bridges={bridges}
        subscribers={subscribers}
        user={user}
        readOnly={isGuest}
        live={live ? 'ws' : 'poll'}
        activeTab={activeTab}
        onSelectTab={(tab) => setActiveTab(tab)}
        onAddServer={() => setIsAddServerOpen(true)}
        onAddSubscriber={() => {
          setEditingSubscriber(null);
          setIsAddSubscriberOpen(true);
        }}
        onOpenAccount={() => setIsAccountOpen(true)}
        onLogout={async () => {
          await api.logout();
          setUser(null);
        }}
      />

      {offline && (
        <div role="status" className="bg-warn-soft border-b border-line text-warn text-xs">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
            <WifiOff className="w-4 h-4 flex-shrink-0" />
            <span>Нет связи с панелью: показаны последние полученные данные, панель переподключится сама.</span>
          </div>
        </div>
      )}

      {isGuest && (
        <div className="bg-info-soft border-b border-line text-info text-xs">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
            <Eye className="w-4 h-4 flex-shrink-0" />
            <span>Гостевой режим: панель открыта только для просмотра. Ссылки подписок, ключи и доступы к серверам скрыты.</span>
          </div>
        </div>
      )}

      {panelIpChange && (
        <div role="status" className="bg-warn-soft border-b border-line text-warn text-xs">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>
              IP панели изменился: <span className="font-mono">{panelIpChange.known}</span> → <span className="font-mono">{panelIpChange.detected}</span>.
              Домен, мосты и резервный домен пока ведут на старый адрес.
            </span>
            <button onClick={() => setActiveTab('security')} className="underline hover:text-ink">
              Обновить адрес
            </button>
          </div>
        </div>
      )}

      {migrationState === 'exporting' && (
        <div className="bg-warn-soft border-b border-line text-warn text-xs">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>
              Идёт перенос панели на другой сервер: изменения сейчас не сохраняются, опрос нод приостановлен.
            </span>
            <button onClick={() => setActiveTab('security')} className="underline hover:text-ink">
              Завершить или отменить перенос
            </button>
          </div>
        </div>
      )}

      <main ref={mainRef} className="flex-1 max-w-[1600px] w-full mx-auto px-4 sm:px-6 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <React.Suspense fallback={<div className="flex items-center justify-center py-24 text-faint text-sm">Загрузка раздела...</div>}>
        <div className={activeTab === 'servers' && servers.length > 0 ? '' : 'max-w-7xl mx-auto space-y-8'}>
        {activeTab === 'docs' ? (
          <DocumentationView />
        ) : loading ? (
          <div className="flex items-center justify-center py-24 text-faint text-sm">
            Загрузка данных...
          </div>
        ) : activeTab === 'bridges' ? (
          <BridgesView servers={servers} onSubscriptionUrlChange={setSubscriptionUrl} />
        ) : activeTab === 'providers' ? (
          <ProvidersView />
        ) : activeTab === 'partners' ? (
          <PartnersView servers={servers} publicUrl={publicUrl} onChanged={loadData} />
        ) : activeTab === 'subscription' ? (
          <SubscriptionSettingsView subscribers={subscribers} publicUrl={subscriptionBase} />
        ) : activeTab === 'events' ? (
          <EventsView />
        ) : activeTab === 'security' ? (
          /* Security: HTTPS & Fail2ban Tab */
          <SecurityView
            publicUrl={publicUrl}
            onSettingsSaved={(settings) => setPublicUrl(settings.public_url || null)}
            onMigrationChange={loadData}
          />
        ) : activeTab === 'subscribers' ? (
          /* Subscribers & Multi-Node Subscriptions Tab */
          <SubscribersList
            subscribers={subscribers}
            onAddSubscriber={() => {
              setEditingSubscriber(null);
              setIsAddSubscriberOpen(true);
            }}
            onEditSubscriber={(sub) => {
              setEditingSubscriber(sub);
              setIsAddSubscriberOpen(true);
            }}
            onShowSubscription={(sub) => setSubscriptionModalSubId(sub.id)}
            onSubscriberUpdated={(updated) => {
              setSubscribers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
            }}
            onSubscriberDeleted={(id) => {
              setSubscribers((prev) => prev.filter((s) => s.id !== id));
            }}
          />
        ) : servers.length === 0 ? (
          /* Empty Servers Screen */
          <div className="max-w-2xl mx-auto text-center py-16 px-6 bg-card border border-line rounded-2xl shadow-pop space-y-6">
            <div className="w-16 h-16 rounded-2xl bg-brand mx-auto flex items-center justify-center shadow-pop">
              <ShieldCheck className="w-9 h-9 text-on-accent stroke-[2.5]" />
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-ink tracking-tight">
                Добро пожаловать в Dementia Panel
              </h2>
              <p className="text-sm text-muted max-w-lg mx-auto">
                Добавляйте удаленные серверы по SSH, и панель автоматически развернет изолированный Docker-контейнер с AmneziaWG или VLESS Reality и сгенерирует подписки для клиентов.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-left pt-2">
              <div className="p-4 bg-paper border border-line rounded-2xl">
                <Terminal className="w-5 h-5 text-ok mb-2" />
                <h4 className="text-xs font-semibold text-ink">Agentless по SSH</h4>
                <p className="text-xs text-muted mt-1">Никаких сторонних демонов на сервере — только чистый Docker.</p>
              </div>

              <div className="p-4 bg-paper border border-line rounded-2xl">
                <Sparkles className="w-5 h-5 text-info mb-2" />
                <h4 className="text-xs font-semibold text-ink">Параметры протокола</h4>
                <p className="text-xs text-muted mt-1">Автоматическая генерация параметров AmneziaWG или Reality для каждой ноды.</p>
              </div>

              <div className="p-4 bg-paper border border-line rounded-2xl">
                <Zap className="w-5 h-5 text-warn mb-2" />
                <h4 className="text-xs font-semibold text-ink">Подписки Incy и mihomo</h4>
                <p className="text-xs text-muted mt-1">Автообновление списка серверов без ручной настройки.</p>
              </div>
            </div>

            <div className="pt-4">
              <button
                onClick={() => setIsAddServerOpen(true)}
                className="inline-flex items-center gap-2 bg-brand text-on-accent font-bold text-sm px-6 py-3 rounded-2xl transition border border-line btn-press"
              >
                <Plus className="w-4 h-4" />
                <span>Добавить первый сервер</span>
              </button>
            </div>
          </div>
        ) : (
          /* Карта сети с инспектором (или список) */
          <ServersView
            readOnly={isGuest}
            servers={servers}
            bridges={bridges}
            subscribers={subscribers}
            clients={clients}
            selectedServerId={selectedServerId}
            onSelectServer={(id) => {
              if (id !== selectedServerId) setClients([]);
              setSelectedServerId(id);
            }}
            onInstallServer={(s) => setInstallModalServer(s)}
            onEditParams={(s) => setParamsModalServer(s)}
            onServerDeleted={handleServerDeleted}
            onEditServer={(s) => setEditingServer(s)}
            onServerChanged={loadData}
            onAddClient={() => setIsAddClientOpen(true)}
            onShowQr={handleShowQr}
            onClientUpdated={handleClientUpdated}
            onClientDeleted={handleClientDeleted}
            onOpenBridges={() => setActiveTab('bridges')}
          />
        )}
        </div>
        </React.Suspense>
      </main>

      {/* Modals */}
      <AddServerModal
        isOpen={isAddServerOpen || !!editingServer}
        editingServer={editingServer}
        onClose={() => {
          setIsAddServerOpen(false);
          setEditingServer(null);
        }}
        onServerAdded={handleServerAdded}
        onServerUpdated={handleServerUpdated}
        onImported={loadData}
      />

      <InstallLogsModal
        isOpen={!!installModalServer}
        server={installModalServer}
        onClose={() => setInstallModalServer(null)}
        onFinished={loadData}
      />

      {paramsModalServer?.protocol === 'vless' ? (
        <VlessParamsModal
          key={paramsModalServer.id}
          server={paramsModalServer}
          onClose={() => setParamsModalServer(null)}
          onUpdated={handleServerUpdated}
        />
      ) : (
        <AwgParamsModal
          isOpen={!!paramsModalServer}
          server={paramsModalServer}
          onClose={() => setParamsModalServer(null)}
          onUpdated={handleServerUpdated}
        />
      )}

      <AddClientModal
        isOpen={isAddClientOpen}
        serverId={selectedServerId}
        serverName={selectedServer?.name || ''}
        protocol={selectedServer?.protocol}
        onClose={() => setIsAddClientOpen(false)}
        onClientAdded={handleClientAdded}
      />

      <AddSubscriberModal
        isOpen={isAddSubscriberOpen}
        servers={servers}
        editingSubscriber={editingSubscriber}
        onClose={() => setIsAddSubscriberOpen(false)}
        onSaved={() => loadData()}
      />

      <SubscriptionModal
        isOpen={!!subscriptionModalSub}
        subscriber={subscriptionModalSub}
        publicUrl={subscriptionBase}
        onClose={() => setSubscriptionModalSubId(null)}
        onTokenReset={(updated) => {
          setSubscribers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        }}
      />

      <AccountModal
        isOpen={isAccountOpen}
        user={user}
        onClose={() => setIsAccountOpen(false)}
        onUsernameChanged={(updated) => setUser(updated)}
      />

      <QrCodeModal
        isOpen={!!qrModalClientId}
        clientId={qrModalClientId}
        qrData={qrData}
        onClose={() => {
          setQrModalClientId(null);
          setQrData(null);
        }}
      />
    </div>
  );
};

export default App;
