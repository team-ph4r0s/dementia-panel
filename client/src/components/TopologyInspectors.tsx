import React from 'react';
import { Waypoints, Globe2, ExternalLink } from 'lucide-react';
import type { Bridge, Server, Subscriber } from '../types';
import { countryFlag, countryName } from '../utils';
import { UNKNOWN_COUNTRY } from '../topology/model';
import { ProtocolBadge } from './ProtocolBadge';
import { ProbeBadges } from './ProbeBadges';

const STATUS_TEXT: Record<Bridge['status'], string> = {
  online: 'Мост работает',
  installing: 'Идёт установка',
  offline: 'Нет связи',
  error: 'Ошибка',
  uninstalled: 'Не установлен',
};

const STATUS_CLASS: Record<Bridge['status'], string> = {
  online: 'bg-ok-soft text-ok',
  installing: 'bg-warn-soft text-warn',
  offline: 'bg-bad-soft text-bad',
  error: 'bg-bad-soft text-bad',
  uninstalled: 'bg-soft text-muted',
};

const MODE_TEXT = { auto: 'авто', always: 'всегда', off: 'выключен' } as const;

export const BridgeInspector: React.FC<{ bridge: Bridge; servers: Server[]; onOpenBridges: () => void }> = ({ bridge, servers, onOpenBridges }) => (
  <div className="space-y-4">
    <div className="flex items-start gap-3">
      <div className="w-11 h-11 rounded-xl bg-soft border border-line flex items-center justify-center shrink-0">
        <Waypoints className="w-5 h-5 text-violet" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-bold text-ink break-all">{bridge.name}</h2>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_CLASS[bridge.status]}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            {STATUS_TEXT[bridge.status]}
          </span>
        </div>
        <div className="text-xs text-muted mt-0.5 font-mono break-all">
          {bridge.host} · {bridge.country ? `${countryFlag(bridge.country)} ${countryName(bridge.country)}` : 'страна не задана'}
        </div>
      </div>
    </div>

    {(bridge.last_error || bridge.needs_apply) && (
      <div className="bg-warn-soft border border-line rounded-xl p-3 text-xs text-warn space-y-1">
        {bridge.needs_apply && <p>Правила пересылки изменены и ещё не применены на мосту.</p>}
        {bridge.last_error && <p className="break-all">Последняя ошибка: {bridge.last_error}</p>}
      </div>
    )}

    <div className="space-y-2">
      <div className="text-xs font-mono uppercase tracking-wide text-faint">Привязанные ноды · {bridge.links.length}</div>
      {bridge.links.length === 0 && <p className="text-xs text-muted">Ни одна нода не привязана — пересылать нечего.</p>}
      {bridge.links.map((link) => {
        const server = servers.find((s) => s.id === link.server_id);
        const live = link.active && link.check_ok !== false && bridge.status === 'online';
        return (
          <div key={link.server_id} className="bg-paper border border-line rounded-lg px-3 py-2 text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold text-ink">{server?.name ?? link.server_name}</span>
            {server && <ProtocolBadge protocol={server.protocol} />}
            <span className="font-mono text-faint">порт {link.listen_port} → {link.awg_port}</span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-soft text-muted">{MODE_TEXT[link.mode]}</span>
              {link.check_ok === false && <span className="px-1.5 py-0.5 rounded bg-bad-soft text-bad">пересылка не работает</span>}
              {live && <span className="px-1.5 py-0.5 rounded bg-ok-soft text-ok">выдаётся пользователям</span>}
            </span>
          </div>
        );
      })}
    </div>

    <button
      data-guest-ok
      onClick={onOpenBridges}
      className="flex items-center gap-1.5 bg-soft hover:bg-soft-2 text-ink text-xs font-medium px-3 py-2 rounded-lg border border-line transition"
    >
      <ExternalLink className="w-3.5 h-3.5 text-brand" />
      Управление мостами
    </button>
  </div>
);

export const CountryInspector: React.FC<{ code: string; servers: Server[]; bridges: Bridge[]; subscribers: Subscriber[] }> = ({ code, servers, bridges, subscribers }) => {
  const unknown = code === UNKNOWN_COUNTRY;
  const people = subscribers.filter((s) => (s.country ? s.country.toUpperCase() : UNKNOWN_COUNTRY) === code);
  const localBridges = bridges.filter((b) => (b.country || '').toUpperCase() === code);
  const probed = servers.filter((s) => (s.probes ?? []).some((p) => p.country.toUpperCase() === code));

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-soft border border-line flex items-center justify-center shrink-0">
          {unknown ? <Globe2 className="w-5 h-5 text-info" /> : <span className="text-2xl leading-none">{countryFlag(code)}</span>}
        </div>
        <div>
          <h2 className="text-lg font-bold text-ink">{unknown ? 'Страна не задана' : countryName(code)}</h2>
          <div className="text-xs text-muted mt-0.5 font-mono">
            {people.length} польз. · {people.reduce((a, s) => a + (s.peer_count || 0), 0)} пиров
          </div>
        </div>
      </div>

      {unknown && <p className="text-xs text-muted">Страну пользователя можно задать в его карточке: по ней подписка выбирает мост и показывает доступность нод.</p>}

      {probed.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-mono uppercase tracking-wide text-faint">Доступность нод из страны</div>
          {probed.map((s) => (
            <div key={s.id} className="bg-paper border border-line rounded-lg px-3 py-2 text-xs flex items-center gap-2">
              <span className="font-semibold text-ink">{s.name}</span>
              <ProtocolBadge protocol={s.protocol} />
              <span className="ml-auto">
                <ProbeBadges probes={(s.probes ?? []).filter((p) => p.country.toUpperCase() === code)} showRtt />
              </span>
            </div>
          ))}
        </div>
      )}

      {localBridges.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-mono uppercase tracking-wide text-faint">Мосты в стране</div>
          {localBridges.map((b) => (
            <div key={b.id} className="bg-paper border border-line rounded-lg px-3 py-2 text-xs flex items-center gap-2">
              <Waypoints className="w-3.5 h-3.5 text-violet" />
              <span className="font-semibold text-ink">{b.name}</span>
              <span className="ml-auto text-muted">{STATUS_TEXT[b.status]}</span>
            </div>
          ))}
        </div>
      )}

      {people.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-mono uppercase tracking-wide text-faint">Пользователи</div>
          <ul className="space-y-1">
            {people.slice(0, 12).map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-xs bg-paper border border-line rounded-lg px-3 py-1.5">
                <span className={`w-2 h-2 rounded-full ${s.suspended || !s.enabled ? 'bg-faint' : 'bg-ok'}`} />
                <span className="text-ink">{s.name}</span>
                <span className="ml-auto font-mono text-faint">{s.server_ids.length} нод</span>
              </li>
            ))}
          </ul>
          {people.length > 12 && <p className="text-xs text-faint">и ещё {people.length - 12}</p>}
        </div>
      )}
    </div>
  );
};
