import React, { useEffect, useMemo, useState } from 'react';
import { Palette, Save, Loader2, ArrowUp, ArrowDown, Smartphone, Eye, Link2, Server as ServerIcon } from 'lucide-react';
import type { DirectRouting, Subscriber, SubscriptionServer, SubscriptionSettings } from '../types';
import { api } from '../api';
import { copyToClipboard } from '../utils';
import { AwgClientsGuide } from './AwgClientsGuide';
import { DirectRoutingCard } from './DirectRoutingCard';
import { toDraft, type DirectDraft } from './directDraft';
import { useFeedback } from './ui/feedback-context';

const TITLE_MAX = 25;
const ANNOUNCE_MAX = 200;

const inputClass =
  'w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm';
const labelClass = 'block text-xs font-medium text-muted mb-1';
const cardClass = 'bg-card border border-line rounded-2xl p-6 shadow-pop space-y-4';

function renderTitle(template: string, user: string): string {
  const title = (template || '{user}').split('{user}').join(user);
  const chars = [...title];
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : title;
}

export const SubscriptionSettingsView: React.FC<{ subscribers: Subscriber[]; publicUrl: string | null }> = ({
  subscribers,
  publicUrl,
}) => {
  const { alert: showAlert } = useFeedback();
  const [settings, setSettings] = useState<SubscriptionSettings | null>(null);
  const [servers, setServers] = useState<SubscriptionServer[]>([]);
  const [direct, setDirect] = useState<DirectDraft | null>(null);
  const [directStatus, setDirectStatus] = useState<DirectRouting['countries_status']>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);

  useEffect(() => {
    api
      .getSubscriptionSettings()
      .then((data) => {
        setSettings(data.settings);
        setServers(data.servers);
        setDirect(toDraft(data.direct));
        setDirectStatus(data.direct.countries_status);
      })
      .catch((err) => setMessage({ type: 'error', text: err.message }));
  }, []);

  const previewSubscriber = subscribers.find((s) => s.id === previewId) || subscribers[0] || null;

  const previewServers = useMemo(() => {
    if (!previewSubscriber) return servers;
    const ids = new Set(previewSubscriber.server_ids);
    return servers.filter((s) => ids.has(s.id));
  }, [servers, previewSubscriber]);

  if (!settings || !direct) {
    return message ? (
      <div className="p-4 rounded-2xl border bg-bad-soft border-line text-bad text-xs">{message.text}</div>
    ) : (
      <div className="flex items-center justify-center py-24 text-faint text-sm">Загрузка настроек подписки...</div>
    );
  }

  const update = <K extends keyof SubscriptionSettings>(key: K, value: SubscriptionSettings[K]) =>
    setSettings({ ...settings, [key]: value });

  const titleLength = [...settings.title.split('{user}').join('')].length;
  const announceLength = [...settings.announce].length;

  const moveServer = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= servers.length) return;
    const next = [...servers];
    [next[index], next[target]] = [next[target], next[index]];
    setServers(next.map((s, i) => ({ ...s, sub_order: i })));
  };

  const renameServer = (id: number, subName: string) => {
    setServers(servers.map((s) => (s.id === id ? { ...s, sub_name: subName } : s)));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const data = await api.updateSubscriptionSettings({
        settings: { ...settings, update_interval: Number(settings.update_interval) },
        servers: servers.map((s, i) => ({ id: s.id, sub_name: s.sub_name || '', sub_order: i })),
        direct: { enabled: direct.enabled, awg: direct.awg, countries: direct.countries, domains: direct.domains, cidrs: direct.cidrs },
      });
      setSettings(data.settings);
      setServers(data.servers);
      setDirect(toDraft(data.direct));
      setDirectStatus(data.direct.countries_status);
      const failed = (data.refresh ?? []).filter((r) => r.error);
      setMessage(failed.length
        ? { type: 'error', text: `Сохранено, но списки сетей не загрузились: ${failed.map((r) => r.error).join('; ')}` }
        : {
            type: 'success',
            text: 'Сохранено. Приложения получат изменения при следующем обновлении подписки (или после ручного обновления).',
          });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const baseUrl = previewSubscriber ? api.getSubscriptionUrl(previewSubscriber.token, publicUrl) : '';
  const links = previewSubscriber
    ? [
        { label: 'Основная (Incy)', url: baseUrl },
        { label: 'mihomo / Clash Meta', url: `${baseUrl}?format=clash` },
        { label: 'JSON-контейнер Incy', url: `${baseUrl}?format=json` },
      ]
    : [];

  return (
    <form onSubmit={handleSave} className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink flex items-center gap-2">
            <Palette className="w-5 h-5 text-accent" />
            <span>Оформление подписки</span>
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Как подписка выглядит в приложении Incy: название, объявление, ссылки поддержки и имена серверов
          </p>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="flex items-center justify-center gap-2 bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2.5 rounded-lg transition btn-press hover:text-on-accent"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>Сохранить</span>
        </button>
      </div>

      {message && (
        <div
          className={`p-4 rounded-2xl border text-xs ${
            message.type === 'success'
              ? 'bg-ok-soft border-line text-ok'
              : 'bg-bad-soft border-line text-bad'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Appearance */}
          <div className={cardClass}>
            <h3 className="text-sm font-semibold text-ink">Внешний вид</h3>

            <div>
              <label className={labelClass}>
                Название подписки <span className="text-faint">({titleLength}/{TITLE_MAX}, без учёта {'{user}'})</span>
              </label>
              <input value={settings.title} onChange={(e) => update('title', e.target.value)} className={inputClass} placeholder="{user}" />
              <p className="text-xs text-faint mt-1">
                <code className="text-muted">{'{user}'}</code> заменяется именем пользователя. Длинные названия обрезаются до 25 символов.
              </p>
            </div>

            <div>
              <label className={labelClass}>Описание</label>
              <textarea
                rows={2}
                value={settings.description}
                onChange={(e) => update('description', e.target.value)}
                className={inputClass}
                placeholder="Например: Быстрые серверы в Европе"
              />
            </div>

            <div>
              <label className={labelClass}>
                Объявление на главном экране <span className="text-faint">({announceLength}/{ANNOUNCE_MAX})</span>
              </label>
              <textarea
                rows={3}
                maxLength={ANNOUNCE_MAX * 2}
                value={settings.announce}
                onChange={(e) => update('announce', e.target.value)}
                className={inputClass}
                placeholder="Например: 15 ноября плановые работы с 02:00 до 04:00"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Обновление, ч</label>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={settings.update_interval}
                  onChange={(e) => update('update_interval', Number(e.target.value))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Сортировка серверов</label>
                <select
                  value={settings.sort_order}
                  onChange={(e) => update('sort_order', e.target.value as SubscriptionSettings['sort_order'])}
                  className={inputClass}
                >
                  <option value="">Настройка приложения</option>
                  <option value="none">Как в панели</option>
                  <option value="ping">По пингу</option>
                  <option value="name">По имени</option>
                </select>
              </div>
              <label className="flex items-end gap-2 text-xs text-muted pb-2 cursor-pointer">
                <input type="checkbox" checked={settings.hide_url} onChange={(e) => update('hide_url', e.target.checked)} />
                <span>Скрыть ссылку подписки от пользователя</span>
              </label>
            </div>
          </div>

          {/* Links */}
          <div className={cardClass}>
            <h3 className="text-sm font-semibold text-ink">Ссылки и поддержка</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Поддержка (Telegram, сайт)</label>
                <input type="url" value={settings.support_url} onChange={(e) => update('support_url', e.target.value)} className={inputClass} placeholder="https://t.me/support" />
              </div>
              <div>
                <label className={labelClass}>Email поддержки</label>
                <input type="email" value={settings.support_email} onChange={(e) => update('support_email', e.target.value)} className={inputClass} placeholder="support@example.com" />
              </div>
              <div>
                <label className={labelClass}>Сайт</label>
                <input type="url" value={settings.web_page_url} onChange={(e) => update('web_page_url', e.target.value)} className={inputClass} placeholder="https://example.com" />
              </div>
              <div>
                <label className={labelClass}>Ссылка из объявления</label>
                <input type="url" value={settings.announce_url} onChange={(e) => update('announce_url', e.target.value)} className={inputClass} placeholder="https://example.com/news" />
              </div>
            </div>
          </div>

          <DirectRoutingCard
            draft={direct}
            status={directStatus}
            onChange={setDirect}
            onRefresh={async () => {
              try {
                const data = await api.refreshDirectCountries(direct.countries);
                setDirectStatus(data.direct.countries_status);
                const failed = data.results.filter((r) => r.error);
                setMessage(failed.length
                  ? { type: 'error', text: failed.map((r) => r.error).join('; ') }
                  : { type: 'success', text: 'Списки сетей обновлены.' });
              } catch (err: any) {
                setMessage({ type: 'error', text: err.message });
              }
            }}
          />

          {/* Servers */}
          <div className={cardClass}>
            <div>
              <h3 className="text-sm font-semibold text-ink">Серверы в подписке</h3>
              <p className="text-xs text-faint mt-0.5">
                Имя, которое увидит пользователь (можно с эмодзи флага), и порядок в списке. Пустое поле — имя сервера в панели.
              </p>
            </div>
            {servers.length === 0 ? (
              <p className="text-xs text-faint">Серверы ещё не добавлены.</p>
            ) : (
              <div className="space-y-2">
                {servers.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-2">
                    <div className="flex flex-col">
                      <button type="button" onClick={() => moveServer(i, -1)} disabled={i === 0} className="p-0.5 text-faint hover:text-ink disabled:opacity-30" title="Выше">
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => moveServer(i, 1)} disabled={i === servers.length - 1} className="p-0.5 text-faint hover:text-ink disabled:opacity-30" title="Ниже">
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {/* На телефоне имя в панели — над полем, иначе поле сжимается до нескольких символов */}
                    <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2">
                      <div className="sm:w-40 sm:flex-shrink-0 min-w-0">
                        <p className="text-xs font-medium text-ink truncate">{s.name}</p>
                        <p className="text-xs font-mono text-faint truncate">{s.host}</p>
                      </div>
                      <input
                        value={s.sub_name || ''}
                        maxLength={64}
                        aria-label={`Имя «${s.name}» в подписке`}
                        onChange={(e) => renameServer(s.id, e.target.value)}
                        placeholder={s.name}
                        className={inputClass}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Preview & compatibility */}
        <div className="space-y-6">
          <div className={cardClass}>
            <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
              <Eye className="w-4 h-4 text-ok" />
              <span>Предпросмотр</span>
            </h3>
            {subscribers.length > 0 && (
              <select
                value={previewSubscriber?.id ?? ''}
                onChange={(e) => setPreviewId(Number(e.target.value))}
                className={inputClass}
              >
                {subscribers.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.name}
                  </option>
                ))}
              </select>
            )}
            <div className="rounded-2xl bg-paper border border-line p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-faint" />
                <span className="text-sm font-semibold text-ink">{renderTitle(settings.title, previewSubscriber?.name || 'Пользователь')}</span>
              </div>
              {settings.description && <p className="text-xs text-muted whitespace-pre-line">{settings.description}</p>}
              {settings.announce && (
                <p className="text-xs text-warn bg-warn-soft border border-line rounded-lg p-2 whitespace-pre-line line-clamp-5">
                  {settings.announce}
                </p>
              )}
              <div className="space-y-1">
                {previewServers.length === 0 ? (
                  <p className="text-xs text-faint">Нет серверов</p>
                ) : (
                  previewServers.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 text-xs text-ink bg-card rounded-lg px-2.5 py-1.5">
                      <ServerIcon className="w-3.5 h-3.5 text-ok flex-shrink-0" />
                      <span className="truncate">{s.sub_name || s.name}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {links.length > 0 && (
              <div className="space-y-2">
                {links.map((link) => (
                  <button
                    key={link.label}
                    type="button"
                    onClick={() => copyToClipboard(link.url).then((ok) => {
                      if (!ok) void showAlert(link.url, 'Скопируйте ссылку вручную');
                    })}
                    className="w-full flex items-center gap-2 text-left text-xs bg-paper border border-line hover:border-faint rounded-lg px-2.5 py-2 transition"
                    title="Скопировать ссылку"
                  >
                    <Link2 className="w-3.5 h-3.5 text-ok flex-shrink-0" />
                    <span className="text-ink font-medium flex-shrink-0">{link.label}</span>
                    <span className="text-faint font-mono truncate">{link.url}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>

      <div className={cardClass}>
        <div>
          <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-info" />
            <span>Приложения для подписок</span>
          </h3>
          <p className="text-xs text-muted mt-1">
            Что установить пользователю на каждом устройстве: приложения, которые принимают ссылку подписки (серверы обновляются
            сами), и приложения, куда конфигурацию нужно добавить вручную.
          </p>
        </div>
        <AwgClientsGuide />
      </div>
    </form>
  );
};
