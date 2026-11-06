import React, { useCallback, useEffect, useState } from 'react';
import { Globe2, Loader2 } from 'lucide-react';
import type { FailoverStatus } from '../../types';
import { api } from '../../api';
import { useFeedback } from '../ui/feedback-context';

const inputClass = 'mt-1 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm font-mono text-ink focus:border-brand';

/**
 * Резервный домен подписок (docs/bridges.md#failover): имя без проксирования Cloudflare с A-записями мостов, пересылающих
 * панель, и (по выбору) прямого IP панели. Ссылки подписок выдаются с ним: приложение пробует адреса по очереди.
 */
export const FailoverCard: React.FC<{ refreshKey: number; onChanged: (url: string | null) => void }> = ({ refreshKey, onChanged }) => {
  const { confirm, toast } = useFeedback();
  const [status, setStatus] = useState<FailoverStatus | null>(null);
  const [form, setForm] = useState({ domain: '', includePanel: true, token: '', email: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.getFailover();
      setStatus(next);
      setForm((f) => ({ ...f, domain: f.domain || next.domain, includePanel: next.include_panel }));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, refreshKey]);

  if (!status) return null;
  const forwarding = status.bridges.filter((b) => b.panel_forward);

  const save = async () => {
    setBusy(true);
    try {
      if (!(await confirm({
        title: status.enabled ? 'Обновить резервный домен?' : 'Включить резервный домен подписок?',
        message: `Панель добавит ${form.domain.trim()} в свой сертификат (Let’s Encrypt через Cloudflare) и создаст для имени A-записи без оранжевого облака: IP мостов с пересылкой панели${form.includePanel ? ' и прямой IP панели' : ''}. Новые ссылки подписок будут выдаваться с этим доменом; прежние ссылки продолжат работать.`,
      }))) return;
      const next = await api.configureFailover({
        domain: form.domain.trim(),
        include_panel: form.includePanel,
        ...(form.token.trim() ? { token: form.token.trim() } : {}),
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
      });
      setStatus(next);
      setForm((f) => ({ ...f, token: '' }));
      onChanged(next.url);
      toast('Резервный домен подписок включён', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось включить резервный домен', 'error');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      if (!(await confirm({
        title: 'Выключить резервный домен?',
        message: 'A-записи домена будут удалены. Ссылки подписок, уже выданные с резервным доменом, перестанут работать — пользователям понадобятся новые.',
        danger: true,
        confirmLabel: 'Выключить',
      }))) return;
      const next = await api.disableFailover();
      setStatus(next);
      onChanged(null);
      toast(next.error ?? 'Резервный домен выключен', next.error ? 'error' : 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось выключить резервный домен', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="failover-title" className="bg-card border border-line rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1 max-w-3xl">
          <h2 id="failover-title" className="flex items-center gap-2 font-display text-lg font-bold text-ink">
            <Globe2 className="w-5 h-5 text-violet" /> Резервный домен подписок
            {status.enabled && <span className="text-xs font-semibold rounded-full px-2.5 py-0.5 bg-ok-soft text-ok">включён</span>}
          </h2>
          <p className="text-xs text-muted">
            Одна ссылка подписки — несколько путей к панели. У домена без оранжевого облака панель держит A-записи: IP мостов с включённой
            «Панелью через мост» и, по выбору, прямой IP панели. Мост пересылает порт панели как есть, TLS завершается на панели. Если
            один адрес заблокирован, приложение подключается к следующему. Работает и там, где режут Cloudflare.
          </p>
        </div>
        {busy && <Loader2 className="w-4 h-4 animate-spin text-info" />}
      </div>

      {status.error && <p className="p-3 bg-bad-soft text-bad rounded-lg text-xs">{status.error}</p>}

      {status.enabled && status.url && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div className="bg-paper border border-line rounded-lg px-3 py-2">
            <dt className="text-faint">Ссылки подписок</dt>
            <dd className="font-mono text-ink break-all">{status.url}/sub/…</dd>
          </div>
          <div className="bg-paper border border-line rounded-lg px-3 py-2">
            <dt className="text-faint">Адреса в DNS</dt>
            <dd className="font-mono text-ink break-all">{status.published.length ? status.published.join(', ') : '—'}</dd>
          </div>
        </dl>
      )}

      {forwarding.length === 0 && (
        <p className="p-3 bg-warn-soft text-warn rounded-lg text-xs">
          Ни на одном мосту не включена «Панель через мост» — без неё резервный домен ведёт только на прямой IP панели.
        </p>
      )}
      {status.bridges.some((b) => b.panel_forward && !b.ipv4) && (
        <p className="text-xs text-warn">Мосты, заданные доменом, в DNS не попадают — укажите у них IPv4-адрес.</p>
      )}

      <fieldset disabled={busy} className="space-y-3 min-w-0 disabled:opacity-50">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
          <label className="text-xs text-muted">
            Домен (поддомен без оранжевого облака)
            <input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="sub.example.com" className={inputClass} />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink pb-2">
            <input type="checkbox" checked={form.includePanel} onChange={(e) => setForm({ ...form, includePanel: e.target.checked })} />
            Прямой IP панели в DNS
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs text-muted">
            Токен Cloudflare
            <input type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder={status.token_saved ? 'сохранён' : 'Zone:Read + DNS:Edit'} className={inputClass} />
          </label>
          <label className="text-xs text-muted">
            Email Let’s Encrypt
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={status.email || 'для выпуска сертификата'} className={inputClass} />
          </label>
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          {status.enabled && (
            <button type="button" onClick={() => void disable()} className="px-3 py-2 text-xs font-medium text-bad bg-soft hover:bg-soft-2 rounded-lg btn-press border border-line">
              Выключить
            </button>
          )}
          <button
            type="button"
            disabled={!form.domain.trim()}
            onClick={() => void save()}
            className="bg-brand text-on-accent font-bold text-sm px-4 py-2 rounded-lg btn-press disabled:opacity-50"
          >
            {status.enabled ? 'Обновить' : 'Включить резервный домен'}
          </button>
        </div>
      </fieldset>
    </section>
  );
};
