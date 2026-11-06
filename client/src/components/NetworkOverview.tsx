import React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Bridge, Server } from '../types';
import { countryName } from '../utils';
import type { Selection } from '../topology/model';

interface NetworkOverviewProps {
  servers: Server[];
  bridges: Bridge[];
  onSelect: (selection: Selection) => void;
  /** Подсказка про управление картой: в режиме «Список» карты нет */
  showMapHint?: boolean;
}

interface Attention {
  key: string;
  level: 'bad' | 'warn' | 'info';
  text: string;
  target: Selection;
}

const LEVEL_CLASS = { bad: 'text-bad bg-bad-soft', warn: 'text-warn bg-warn-soft', info: 'text-info bg-info-soft' } as const;

/** Что требует внимания: ноды и мосты без связи, неприменённые изменения, устаревший протокол, недоступность из стран */
function collectAttention(servers: Server[], bridges: Bridge[]): Attention[] {
  const items: Attention[] = [];
  for (const s of servers) {
    const target: Selection = { kind: 'server', id: s.id };
    if (s.status === 'offline' || s.status === 'error') {
      items.push({ key: `down-${s.id}`, level: 'bad', text: `${s.name}: нет связи${s.last_error ? ` — ${s.last_error}` : ''}`, target });
    }
    if (s.status !== 'uninstalled' && (s.needs_apply || s.needs_sync)) {
      items.push({ key: `sync-${s.id}`, level: 'warn', text: `${s.name}: изменения ещё не доставлены на ноду`, target });
    }
    if (s.remote_panel_id === null && s.status !== 'uninstalled' && s.protocol !== 'vless' && s.awg_version < s.latest_awg_version) {
      items.push({ key: `old-${s.id}`, level: 'info', text: `${s.name}: доступен AmneziaWG ${s.latest_awg_version}.x`, target });
    }
    for (const p of s.probes ?? []) {
      if (p.status === 'fail') {
        items.push({ key: `probe-${s.id}-${p.country}`, level: 'warn', text: `${s.name}: недоступна из страны ${countryName(p.country)}`, target });
      }
    }
  }
  for (const b of bridges) {
    if (b.status === 'offline' || b.status === 'error') {
      items.push({ key: `bridge-${b.id}`, level: 'bad', text: `Мост ${b.name}: нет связи`, target: { kind: 'bridge', id: b.id } });
    }
  }
  return items;
}

export const NetworkOverview: React.FC<NetworkOverviewProps> = ({ servers, bridges, onSelect, showMapHint = true }) => {
  const online = servers.filter((s) => s.status === 'online').length;
  const peers = servers.reduce((acc, s) => acc + (s.active_client_count || 0), 0);
  const total = servers.reduce((acc, s) => acc + (s.client_count || 0), 0);
  const attention = collectAttention(servers, bridges);
  const headline = online === servers.length ? ['Сеть работает.', 'Вся.'] : online === 0 ? ['Сеть молчит.', 'Ни одной ноды.'] : ['Сеть работает.', 'Почти вся.'];

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-mono uppercase tracking-wide text-faint">Состояние сети</div>
        <h2 className="text-2xl font-bold leading-tight text-ink mt-1">
          {headline[0]}
          <br />
          <span className={online === servers.length ? 'text-ok' : online === 0 ? 'text-bad' : 'text-warn'}>{headline[1]}</span>
        </h2>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-xs">
        {[
          ['Ноды', `${online}/${servers.length}`],
          ['Пиры онлайн', `${peers}/${total}`],
          ['Мосты', `${bridges.filter((b) => b.status === 'online').length}/${bridges.length}`],
        ].map(([label, value]) => (
          <div key={label} className="bg-paper border border-line rounded-lg px-3 py-2">
            <dt className="text-faint">{label}</dt>
            <dd className="font-mono font-semibold text-base text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      {attention.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-ok bg-ok-soft rounded-lg px-3 py-2.5">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          Всё в порядке: замечаний нет
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wide text-faint">
            <AlertTriangle className="w-3.5 h-3.5" />
            Требуют внимания · {attention.length}
          </div>
          {attention.map((item) => (
            <button
              key={item.key}
              data-guest-ok
              onClick={() => onSelect(item.target)}
              className={`w-full text-left text-xs rounded-lg px-3 py-2 transition hover:brightness-125 ${LEVEL_CLASS[item.level]}`}
            >
              {item.text}
            </button>
          ))}
        </div>
      )}

      {showMapHint && (
      <p className="text-xs text-faint">
        Нажмите на ноду, мост или страну на карте. Узлы можно перетаскивать, колесо мыши меняет масштаб, пустое место снимает выделение.
      </p>
      )}
    </div>
  );
};
