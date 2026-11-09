import React, { useState } from 'react';
import { Globe2, RefreshCw, X, Loader2 } from 'lucide-react';
import type { DirectRouting } from '../types';
import type { DirectDraft } from './directDraft';
import { COMMON_COUNTRIES, countryFlag, countryName } from '../utils';

const inputClass =
  'w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm';
const labelClass = 'block text-xs font-medium text-muted mb-1';

/**
 * Настройка «Напрямую, мимо VPN»: страны, домены и сети, к которым приложение ходит без туннеля.
 * Правила применяет само приложение пользователя (docs/direct-routing.md).
 */
export const DirectRoutingCard: React.FC<{
  draft: DirectDraft;
  status: DirectRouting['countries_status'];
  onChange: (draft: DirectDraft) => void;
  onRefresh: () => Promise<void>;
}> = ({ draft, status, onChange, onRefresh }) => {
  const [custom, setCustom] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const set = <K extends keyof DirectDraft>(key: K, value: DirectDraft[K]) => onChange({ ...draft, [key]: value });

  const addCountry = (code: string) => {
    const value = code.trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(value) || draft.countries.includes(value)) return;
    set('countries', [...draft.countries, value]);
    setCustom('');
  };
  const networks = (code: string) => status?.find((s) => s.country === code)?.networks ?? 0;

  return (
    <div className="bg-card border border-line rounded-2xl p-6 shadow-pop space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
          <Globe2 className="w-4 h-4 text-brand" />
          <span>Напрямую, мимо VPN</span>
        </h3>
        <p className="text-xs text-faint mt-0.5">
          Сайты и приложения выбранных стран открываются без VPN, даже когда он включён. Правила выполняет приложение на устройстве:
          панель отдаёт их в подписке.
        </p>
      </div>

      <label className="flex items-center gap-2 text-xs text-ink cursor-pointer">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        <span>Включить для всех подписок</span>
      </label>

      <div className={draft.enabled ? 'space-y-4' : 'space-y-4 opacity-50'}>
        <div>
          <label className={labelClass}>Страны</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {draft.countries.length === 0 && <span className="text-xs text-faint">Страны не выбраны</span>}
            {draft.countries.map((code) => (
              <span key={code} className="inline-flex items-center gap-1.5 bg-paper border border-line rounded-lg pl-2.5 pr-1 py-1 text-xs text-ink">
                <span>{countryFlag(code)} {countryName(code)}</span>
                {draft.awg && (
                  <span className={`font-mono ${networks(code) ? 'text-ok' : 'text-warn'}`} title="Сетей в списке страны">
                    {networks(code) || 'нет списка'}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Убрать страну ${countryName(code)}`}
                  onClick={() => set('countries', draft.countries.filter((c) => c !== code))}
                  className="p-1.5 text-faint hover:text-ink rounded-md"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label="Добавить страну"
              value=""
              onChange={(e) => addCountry(e.target.value)}
              className={`${inputClass} flex-1`}
            >
              <option value="">Добавить страну…</option>
              {COMMON_COUNTRIES.filter((c) => !draft.countries.includes(c)).map((code) => (
                <option key={code} value={code}>{countryFlag(code)} {countryName(code)}</option>
              ))}
            </select>
            <input
              aria-label="Код другой страны"
              value={custom}
              maxLength={2}
              onChange={(e) => setCustom(e.target.value.replace(/[^a-zA-Z]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCountry(custom);
                }
              }}
              placeholder="код"
              className={`${inputClass} w-20 font-mono`}
            />
            <button
              type="button"
              onClick={() => addCountry(custom)}
              disabled={custom.length !== 2}
              className="px-3 py-2 text-xs rounded-lg border border-line text-ink hover:border-faint disabled:opacity-40 btn-press"
            >
              Добавить
            </button>
          </div>
          <p className="text-xs text-faint mt-1">
            К сайтам с национальным доменом страны (для России — .ru, .su, .рф) и к её IP-адресам.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Свои домены</label>
            <textarea
              rows={4}
              value={draft.domains}
              onChange={(e) => set('domains', e.target.value)}
              className={`${inputClass} font-mono`}
              placeholder={'sberbank.ru\nyandex.net'}
            />
            <p className="text-xs text-faint mt-1">По одному в строке; поддомены входят.</p>
          </div>
          <div>
            <label className={labelClass}>Свои сети (IP / CIDR)</label>
            <textarea
              rows={4}
              value={draft.cidrs}
              onChange={(e) => set('cidrs', e.target.value)}
              className={`${inputClass} font-mono`}
              placeholder={'203.0.113.0/24\n198.51.100.7'}
            />
            <p className="text-xs text-faint mt-1">IPv4 не шире /8, IPv6 не шире /16.</p>
          </div>
        </div>

        <div className="rounded-xl bg-paper border border-line p-3 space-y-2">
          <label className="flex items-start gap-2 text-xs text-ink cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={draft.awg} onChange={(e) => set('awg', e.target.checked)} />
            <span>
              Применять к конфигам AmneziaWG (Incy, .conf)
              <span className="block text-faint mt-0.5">
                В AmneziaWG нет правил по доменам: из маршрутов клиента вычитаются IP-сети выбранных стран и свои IPv4-сети, домены
                не работают. Конфиг становится длиннее (сотни маршрутов). IPv6 по-прежнему идёт через туннель.
              </span>
            </span>
          </label>
          {draft.awg && draft.countries.length > 0 && (
            <button
              type="button"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await onRefresh();
                } finally {
                  setRefreshing(false);
                }
              }}
              className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-line text-ink hover:border-faint disabled:opacity-50 btn-press"
            >
              {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span>Обновить списки сетей</span>
            </button>
          )}
        </div>

        <p className="text-xs text-faint">
          Полностью работает в приложениях на ядре mihomo (FlClash, Clash Verge, Mihomo Party). В Incy и обычных WireGuard-клиентах —
          только по IP, в v2rayN, Happ и Hiddify правила по ссылке не передаются: их задают в самом приложении.
        </p>
      </div>
    </div>
  );
};
