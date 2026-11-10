import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe2, Loader2, Save, RefreshCw, ChevronDown, ChevronUp, AlertTriangle, Search } from 'lucide-react';
import type { ProbeCountry, ProbesOverview, ProbeSettings } from '../types';
import { api } from '../api';
import { countryFlag, countryName } from '../utils';
import { ProbeBadges } from './ProbeBadges';

const INTERVALS = [10, 15, 30, 60, 120, 360, 720, 1440];

const inputClass =
  'bg-paper border border-line rounded-xl px-3 py-1.5 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-xs';

function intervalLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} мин` : minutes === 1440 ? 'сутки' : `${minutes / 60} ч`;
}

/**
 * Проверка доступности нод из стран, выбранных администратором (docs/probes.md): включение, выбор стран, способ проверки
 * каждой ноды и результаты. Саму проверку выполняют узлы check-host.net.
 */
export const ProbesCard: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [overview, setOverview] = useState<ProbesOverview | null>(null);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ProbeSettings | null>(null);
  const [ports, setPorts] = useState<Record<number, string>>({});
  const [countries, setCountries] = useState<ProbeCountry[] | null>(null);
  const [countriesError, setCountriesError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async (resetForm: boolean) => {
    try {
      const data = await api.getProbes();
      setOverview(data);
      // Форма инициализируется только при открытии/сохранении: фоновое обновление не должно затирать ввод
      if (resetForm) {
        setSettings(data.settings);
        setPorts(Object.fromEntries(data.servers.map((s) => [s.id, s.probe_port ? String(s.probe_port) : ''])));
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  }, []);

  useEffect(() => {
    api
      .getProbes()
      .then((data) => {
        setOverview(data);
        setSettings(data.settings);
        setPorts(Object.fromEntries(data.servers.map((s) => [s.id, s.probe_port ? String(s.probe_port) : ''])));
      })
      .catch((err) => setMessage({ type: 'error', text: err.message }));
  }, []);

  // Пока идёт проверка или карточка открыта, подтягиваем результаты
  useEffect(() => {
    const timer = setInterval(() => load(false), overview?.status.running ? 3000 : 20000);
    return () => clearInterval(timer);
  }, [load, overview?.status.running]);

  useEffect(() => {
    if (!open || countries) return;
    api
      .getProbeCountries()
      .then(setCountries)
      .catch((err) => setCountriesError(err.message));
  }, [open, countries]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (countries ?? []).filter((c) => !query || c.code.includes(query) || countryName(c.code).toLowerCase().includes(query) || c.name.toLowerCase().includes(query));
  }, [countries, search]);

  const settingsDirty = useMemo(() => {
    if (!overview || !settings) return false;
    const o = overview.settings;
    if (settings.enabled !== o.enabled) return true;
    if (settings.interval_minutes !== o.interval_minutes) return true;
    if (Boolean(settings.globalping) !== Boolean(o.globalping)) return true;
    if (settings.countries.length !== o.countries.length) return true;
    for (let i = 0; i < settings.countries.length; i++) {
      if (settings.countries[i] !== o.countries[i]) return true;
    }
    return false;
  }, [overview, settings]);

  if (!overview || !settings) return null;

  const update = <K extends keyof ProbeSettings>(key: K, value: ProbeSettings[K]) => setSettings({ ...settings, [key]: value });

  const toggleCountry = (code: string) => {
    if (settings.countries.includes(code)) {
      update('countries', settings.countries.filter((c) => c !== code));
    } else if (settings.countries.length < overview.max_countries) {
      update('countries', [...settings.countries, code]);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const portUpdates = overview.servers
        .filter((s) => (ports[s.id] ? Number(ports[s.id]) : null) !== s.probe_port)
        .map((s) => ({ id: s.id, probe_port: ports[s.id] ? Number(ports[s.id]) : null }));
      const data = await api.updateProbes({ settings, servers: portUpdates });
      setOverview(data);
      setSettings(data.settings);
      // Список стран зависит от того, включён ли Globalping
      setCountries(null);
      setPorts(Object.fromEntries(data.servers.map((s) => [s.id, s.probe_port ? String(s.probe_port) : ''])));
      setMessage({
        type: 'success',
        text: data.settings.enabled
          ? 'Сохранено. Первая проверка начнётся в течение минуты — результаты появятся на карточках нод и в подписках.'
          : 'Сохранено. Проверка выключена, адреса нод никуда не отправляются.',
      });
      onChanged?.();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    setMessage(null);
    try {
      await api.runProbes();
      await load(false);
      setMessage({ type: 'success', text: 'Проверка запущена, результаты появятся через несколько секунд.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const resultsFor = (serverId: number) => overview.results.filter((r) => r.server_id === serverId);

  return (
    <div className="bg-card border border-line rounded-2xl shadow-pop">
      <button
        type="button"
        data-guest-ok
        onClick={() => {
          setOpen(!open);
          if (!open) load(true);
        }}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left"
      >
        <span className="flex items-center gap-2.5">
          <Globe2 className="w-4 h-4 text-info" />
          <span className="text-sm font-semibold text-ink">Доступность нод из стран</span>
          <span className="text-xs text-faint">
            {overview.settings.enabled
              ? `проверяется из: ${overview.settings.countries.map((c) => countryFlag(c)).join(' ')}`
              : 'выключено'}
          </span>
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-faint" /> : <ChevronDown className="w-4 h-4 text-faint" />}
      </button>

      {open && (
        <form onSubmit={handleSave} className="px-5 pb-5 space-y-5 border-t border-line pt-4">
          <div className="p-3 rounded-xl border bg-warn-soft border-line text-warn text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              Проверку выполняют узлы сервиса <b>check-host.net</b> в выбранных странах: ему передаются адреса ваших нод. На каждую ноду
              панель ставит заглушку — простую страницу на случайном порту, которая отвечает и по TCP, и по UDP. Узлы обращаются к ней,
              а панель по журналу на самой ноде проверяет, что запрос действительно дошёл: подменённый провайдером ответ не засчитывается.
              Проверяется сетевая доступность адреса и UDP-порта; работу самого протокола AmneziaWG она не проверяет — для этого есть сигнал от клиентов в разделе «Мосты».
            </span>
          </div>

          {message && (
            <div
              className={`p-3 rounded-xl border text-xs ${
                message.type === 'success'
                  ? 'bg-ok-soft border-line text-ok'
                  : 'bg-bad-soft border-line text-bad'
              }`}
            >
              {message.text}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
            <input type="checkbox" checked={settings.enabled} onChange={(e) => update('enabled', e.target.checked)} />
            <span>Проверять доступность нод</span>
          </label>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-ink">
                Страны проверки <span className="text-faint font-normal">({settings.countries.length} из {overview.max_countries})</span>
              </h4>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-faint absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск страны" className={`${inputClass} pl-8 w-44`} />
              </div>
            </div>

            {settings.countries.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {settings.countries.map((code) => (
                  <button
                    type="button"
                    key={code}
                    onClick={() => toggleCountry(code)}
                    className="text-xs bg-info-soft border border-line text-info rounded-lg px-2 py-1 hover:bg-info-soft"
                    title="Убрать"
                  >
                    {countryFlag(code)} {countryName(code)} ✕
                  </button>
                ))}
              </div>
            )}

            {countriesError ? (
              <p className="text-xs text-bad">{countriesError}</p>
            ) : !countries ? (
              <p className="text-xs text-faint flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Загрузка списка стран...
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5 max-h-48 overflow-y-auto pr-1">
                {filtered.map((c) => {
                  const selected = settings.countries.includes(c.code);
                  const disabled = !selected && settings.countries.length >= overview.max_countries;
                  return (
                    <label
                      key={c.code}
                      title={c.cities.join(', ')}
                      className={`flex items-center gap-2 text-xs rounded-lg px-2 py-1.5 border cursor-pointer ${
                        selected ? 'bg-info-soft border-line text-ink' : 'bg-paper border-line text-ink'
                      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:border-faint'}`}
                    >
                      <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggleCountry(c.code)} />
                      <span>{countryFlag(c.code)}</span>
                      <span className="truncate">{countryName(c.code)}</span>
                      <span className="ml-auto text-xs text-faint">{c.nodes.length}{c.gp_probes ? ` + ${c.gp_probes}` : ''}</span>
                    </label>
                  );
                })}
                {filtered.length === 0 && <p className="text-xs text-faint col-span-full">Ничего не найдено</p>}
              </div>
            )}
            <p className="text-xs text-faint">Число справа — сколько узлов check-host.net в стране (после «+» — пробы Globalping). Из каждой страны привлекаются до двух узлов каждого источника.</p>
            <label className="flex items-start gap-2 text-xs text-ink cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={Boolean(settings.globalping)} onChange={(e) => update('globalping', e.target.checked)} />
              <span>
                Дополнительно проверять через <b>Globalping</b> — пробы в сетях провайдеров и больше стран. Адреса нод будут передаваться
                и этому сервису (api.globalping.io). Проверяется только TCP; бесплатно до 250 проб в час.
              </span>
            </label>

            {Boolean(settings.globalping) && overview.globalping_budget && (
              <div className="text-xs space-y-1 pl-5">
                {settingsDirty && (
                  <p className="text-faint">(оценка для сохранённых настроек)</p>
                )}
                <p className="text-muted">
                  ≈ {overview.globalping_budget.per_hour} проб в час из {overview.globalping_budget.limit}
                </p>
                {overview.globalping_budget.per_hour > overview.globalping_budget.limit && (
                  <p className="text-warn flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    Оценка выше лимита (250 в час). Рекомендуется увеличить интервал проверки или сократить число выбранных стран.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Проверять каждые</label>
              <select
                value={settings.interval_minutes}
                onChange={(e) => update('interval_minutes', Number(e.target.value))}
                className={`${inputClass} w-full`}
              >
                {INTERVALS.map((m) => (
                  <option key={m} value={m}>
                    {intervalLabel(m)}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-ink cursor-pointer pb-1.5">
              <input type="checkbox" checked={settings.show_in_name} onChange={(e) => update('show_in_name', e.target.checked)} />
              <span>Показывать в названии ноды в подписке</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink cursor-pointer pb-1.5">
              <input type="checkbox" checked={settings.show_in_description} onChange={(e) => update('show_in_description', e.target.checked)} />
              <span>Пояснение в описании подписки</span>
            </label>
          </div>
          <p className="text-xs text-faint">
            В подписке название ноды получит вид «Frankfurt · 🇷🇺✅ 🇰🇿❌»: ✅ доступна, ⚠️ доступна не со всех узлов страны, ❌ недоступна.
            Пометки меняются вместе с результатами — в приложениях на ядре mihomo выбранный вручную сервер при смене пометки придётся выбрать заново
            (отключите «в названии», если это мешает: пояснение в описании останется).
          </p>

          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-ink">Ноды и результаты</h4>
            {overview.servers.length === 0 ? (
              <p className="text-xs text-faint">Установленных нод пока нет.</p>
            ) : (
              <div className="border border-line rounded-xl overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-paper text-muted">
                    <tr>
                      <th className="p-2.5 font-medium">Нода</th>
                      <th className="p-2.5 font-medium">Способ проверки</th>
                      <th className="p-2.5 font-medium">Результат</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line bg-paper">
                    {overview.servers.map((s) => (
                      <tr key={s.id}>
                        <td className="p-2.5">
                          <div className="text-ink font-medium">{s.name}</div>
                          <div className="text-xs font-mono text-faint">{s.host}</div>
                        </td>
                        <td className="p-2.5">
                          {!s.remote_panel_id && (
                            <div className="text-ink mb-1">
                              Заглушка на ноде{' '}
                              <span className="text-faint">
                                {s.stub_port ? `· порт ${s.stub_port}` : '· поставится при первой проверке'}
                              </span>
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <span className="text-faint">{s.remote_panel_id ? 'TCP-порт' : 'запасной TCP-порт'}</span>
                            <input
                              type="number"
                              min={1}
                              max={65535}
                              placeholder="—"
                              value={ports[s.id] ?? ''}
                              onChange={(e) => setPorts({ ...ports, [s.id]: e.target.value })}
                              className={`${inputClass} w-20`}
                            />
                          </div>
                        </td>
                        <td className="p-2.5">
                          {resultsFor(s.id).length > 0 ? <ProbeBadges probes={resultsFor(s.id)} showRtt /> : <span className="text-faint">нет данных</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-faint">
              Нода считается доступной с узла страны, если его запрос (TCP или UDP) записан в журнале самой ноды. Знак ⚑ — узлы получили
              ответ, хотя до ноды запрос не дошёл: ответ подделан по дороге. На ноды партнёров заглушку не поставить (нет SSH-доступа) —
              для них укажите TCP-порт, открытый для всех: он проверяется только по ответу check-host.net, без подтверждения. Запасной порт
              своей ноды используется, если заглушку поставить не удалось. ICMP ping больше не используется: его ответы подделываются.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-faint space-y-0.5">
              {overview.status.running && <div className="text-info">Идёт проверка...</div>}
              {overview.status.last_run && <div>Последняя проверка: {new Date(overview.status.last_run).toLocaleString()}</div>}
              {overview.status.error && <div className="text-bad">Ошибка: {overview.status.error}</div>}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRun}
                disabled={!overview.settings.enabled || overview.status.running}
                className="flex items-center gap-2 bg-soft hover:bg-soft-2 disabled:opacity-40 text-ink font-medium text-xs px-4 py-2 rounded-xl transition border border-line"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-info ${overview.status.running ? 'animate-spin' : ''}`} />
                <span>Проверить сейчас</span>
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-xs px-5 py-2 rounded-lg transition btn-press hover:text-on-accent"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>Сохранить</span>
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
};
