import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Building2, Globe2, Map as MapIcon, List } from 'lucide-react';
import type { Bridge, Client, Server, Subscriber } from '../types';
import { nodeKey, type Selection } from '../topology/model';
import { TopologyMap } from './TopologyMap';
import { ProtocolBadge } from './ProtocolBadge';
import { NodeDetails } from './NodeDetails';
import { NetworkOverview } from './NetworkOverview';
import { BridgeInspector, CountryInspector } from './TopologyInspectors';
import { ClientList } from './ClientList';
import { ProbesCard } from './ProbesCard';
import { ProbeBadges } from './ProbeBadges';
import { NodeUpdatesCard } from './NodeUpdatesCard';
import { NodeCountry } from './NodeCountry';
import { NodeExtraPorts } from './NodeExtraPorts';

const TopologyGlobe = lazy(() => import('./TopologyGlobe').then(({ TopologyGlobe }) => ({ default: TopologyGlobe })));
// Город тянет Three.js — грузится отдельным чанком, только когда выбран этот вид
const TopologyCity = lazy(() => import('./TopologyCity').then(({ TopologyCity }) => ({ default: TopologyCity })));
type ViewMode = 'map' | 'globe' | 'city' | 'list';
const VIEW_KEY = 'dementia.servers.view.v1';

/** Узкий экран (телефон, планшет): карта там тесная, поэтому по умолчанию — список */
const isNarrow = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 1023px)').matches);

function readMode(): ViewMode {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(VIEW_KEY);
  } catch {
    // без localStorage — значение по умолчанию
  }
  if (stored === 'list' || stored === 'globe' || stored === 'city' || stored === 'map') return stored;
  return isNarrow() ? 'list' : 'map';
}

interface ServersViewProps {
  readOnly?: boolean;
  servers: Server[];
  bridges: Bridge[];
  subscribers: Subscriber[];
  clients: Client[];
  selectedServerId: number | null;
  onSelectServer: (id: number | null) => void;
  onInstallServer: (server: Server) => void;
  onEditParams: (server: Server) => void;
  onServerDeleted: (id: number) => void;
  onEditServer: (server: Server) => void;
  onServerChanged: () => void;
  onAddClient: () => void;
  onShowQr: (clientId: number) => void;
  onClientUpdated: (client: Client) => void;
  onClientDeleted: (clientId: number) => void;
  onOpenBridges: () => void;
}

/**
 * Раздел «Серверы»: интерактивная карта сети и инспектор справа (нода с клиентами, мост, страна или сводка сети).
 * Режим «Список» оставляет прежнее представление — переключатель нод и карточка с таблицей клиентов: удобно с телефона,
 * для десятков нод и тем, кому карта не нужна.
 */
export const ServersView: React.FC<ServersViewProps> = (props) => {
  const { servers, bridges, subscribers, clients, selectedServerId, onSelectServer } = props;
  const [mode, setMode] = useState<ViewMode>(readMode);
  const [selection, setSelection] = useState<Selection | null>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);

  const changeMode = (next: ViewMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // без запоминания режима панель работает так же
    }
  };

  // Выбранный на карте объект мог исчезнуть (нода удалена, мост снят): тогда показываем сводку
  const valid =
    selection &&
    (selection.kind === 'server'
      ? servers.some((s) => s.id === selection.id)
      : selection.kind === 'bridge'
        ? bridges.some((b) => b.id === selection.id)
        : true)
      ? selection
      : null;

  const select = (next: Selection | null) => {
    setSelection(next);
    if (next?.kind === 'server') onSelectServer(next.id as number);
    // На узком экране инспектор лежит под картой: прокручиваем к нему
    if (next && window.matchMedia('(max-width: 1023px)').matches) {
      requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  };

  // Esc снимает выделение, пока не открыто модальное окно
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) setSelection(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const selectedServer = valid?.kind === 'server' ? servers.find((s) => s.id === valid.id) ?? null : null;
  const listServer = servers.find((s) => s.id === selectedServerId) ?? servers[0] ?? null;

  const toggle = (
    <div className="inline-flex rounded-lg bg-card border border-line p-0.5" role="group" aria-label="Режим раздела" data-guest-ok>
      {(
        [
          ['map', 'Карта', MapIcon],
          ['globe', 'Глобус', Globe2],
          ['city', 'Город', Building2],
          ['list', 'Список', List],
        ] as const
      ).map(([id, label, Icon]) => (
        <button
          key={id}
          onClick={() => changeMode(id)}
          aria-pressed={mode === id}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition ${mode === id ? 'bg-soft-2 text-brand' : 'text-muted hover:text-ink'}`}
        >
          <Icon className="w-3.5 h-3.5" />
          {label}
        </button>
      ))}
    </div>
  );

  if (mode === 'list') {
    return (
      <div className="space-y-4">
        {!props.readOnly && <NodeUpdatesCard onChanged={props.onServerChanged} />}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {toggle}
        </div>
        <div className="bg-card border border-line rounded-2xl p-5">
          <NetworkOverview
            servers={servers}
            bridges={bridges}
            showMapHint={false}
            onSelect={(s) => s.kind === 'server' && onSelectServer(s.id as number)}
          />
        </div>
        <ProbesCard onChanged={props.onServerChanged} />

        {/* Переключатель нод */}
        <div data-guest-ok className="flex items-center gap-2 overflow-x-auto pb-1">
          {servers.map((s) => {
            const isSelected = s.id === listServer?.id;
            return (
              <button
                key={s.id}
                onClick={() => onSelectServer(s.id)}
                aria-pressed={isSelected}
                className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg border text-xs font-medium transition flex-shrink-0 ${
                  isSelected ? 'bg-soft-2 border-brand/40 text-ink' : 'bg-card border-line text-muted hover:text-ink hover:bg-soft'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    s.status === 'online' ? 'bg-ok' : s.status === 'installing' ? 'bg-warn animate-ping' : s.status === 'error' ? 'bg-danger' : s.status === 'offline' ? 'bg-orange' : 'bg-faint'
                  }`}
                />
                <span className="font-semibold">{s.name}</span>
                <ProtocolBadge protocol={s.protocol} />
                <span className="text-xs font-mono text-faint">{s.host}</span>
                <ProbeBadges probes={s.probes} />
              </button>
            );
          })}
        </div>

        {listServer && (
          <>
            <div className="bg-card border border-line rounded-2xl p-5 shadow-pop">
              <NodeDetails
                server={listServer}
                onInstallServer={props.onInstallServer}
                onEditParams={props.onEditParams}
                onServerDeleted={props.onServerDeleted}
                onEditServer={props.onEditServer}
                onServerChanged={props.onServerChanged}
              />
              <div className="mt-4">
                <NodeCountry key={listServer.id} server={listServer} readOnly={props.readOnly} onChanged={props.onServerChanged} />
                <div className="mt-2">
                  <NodeExtraPorts key={`ports-${listServer.id}`} server={listServer} readOnly={props.readOnly} onChanged={props.onServerChanged} />
                </div>
              </div>
            </div>
            <ClientList
              clients={clients}
              serverName={listServer.name}
              protocol={listServer.protocol}
              serverOnline={listServer.status === 'online'}
              onAddClient={props.onAddClient}
              onShowQr={props.onShowQr}
              onClientUpdated={props.onClientUpdated}
              onClientDeleted={props.onClientDeleted}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!props.readOnly && <NodeUpdatesCard onChanged={props.onServerChanged} />}
      <div className="flex items-center justify-between gap-3 flex-wrap">{toggle}</div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_440px] gap-4 items-start">
        {mode === 'city' ? (
          <Suspense fallback={<p className="rounded-2xl border border-line bg-card p-5 text-xs text-muted">Загружается город…</p>}>
            <TopologyCity
              servers={servers}
              bridges={bridges}
              subscribers={subscribers}
              selected={valid}
              onSelect={select}
              onOpenMap={() => changeMode('map')}
            />
          </Suspense>
        ) : mode === 'globe' ? (
          <Suspense fallback={<p className="rounded-2xl border border-line bg-card p-5 text-xs text-muted">Загружается глобус…</p>}>
            <TopologyGlobe servers={servers} bridges={bridges} subscribers={subscribers} selected={valid} onSelect={select} />
          </Suspense>
        ) : (
          <TopologyMap
            servers={servers}
            bridges={bridges}
            subscribers={subscribers}
            selected={valid}
            onSelect={select}
            className="hud-cut h-[58dvh] min-h-[380px] lg:h-[calc(100dvh-11.5rem)] lg:min-h-[520px] rounded-2xl border border-line bg-page/60"
          />
        )}

        <div
          ref={inspectorRef}
          className="hud-cut lg:h-[calc(100dvh-11.5rem)] lg:min-h-[520px] lg:overflow-y-auto rounded-2xl border border-line bg-card/90 p-5 space-y-5 scroll-mt-32"
          aria-live="polite"
          data-testid="inspector"
        >
          {valid?.kind === 'server' && selectedServer ? (
            <>
              <NodeCountry key={`country-${selectedServer.id}`} server={selectedServer} readOnly={props.readOnly} onChanged={props.onServerChanged} />
              <NodeExtraPorts key={`ports-${selectedServer.id}`} server={selectedServer} readOnly={props.readOnly} onChanged={props.onServerChanged} />
              <NodeDetails
                key={selectedServer.id}
                server={selectedServer}
                onInstallServer={props.onInstallServer}
                onEditParams={props.onEditParams}
                onServerDeleted={(id) => {
                  setSelection(null);
                  props.onServerDeleted(id);
                }}
                onEditServer={props.onEditServer}
                onServerChanged={props.onServerChanged}
              />
              <ClientList
                clients={clients}
                serverName={selectedServer.name}
                protocol={selectedServer.protocol}
                serverOnline={selectedServer.status === 'online'}
                layout="cards"
                onAddClient={props.onAddClient}
                onShowQr={props.onShowQr}
                onClientUpdated={props.onClientUpdated}
                onClientDeleted={props.onClientDeleted}
              />
            </>
          ) : valid?.kind === 'bridge' ? (
            <BridgeInspector bridge={bridges.find((b) => b.id === valid.id)!} servers={servers} onOpenBridges={props.onOpenBridges} />
          ) : valid?.kind === 'country' ? (
            <CountryInspector code={String(valid.id)} servers={servers} bridges={bridges} subscribers={subscribers} />
          ) : (
            <>
              <NetworkOverview servers={servers} bridges={bridges} onSelect={select} />
              <ProbesCard onChanged={props.onServerChanged} />
            </>
          )}
          {valid && (
            <button
              data-guest-ok
              onClick={() => setSelection(null)}
              className="text-xs text-muted hover:text-ink transition"
              data-key={nodeKey(valid.kind, valid.id)}
            >
              ← К сводке сети
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
