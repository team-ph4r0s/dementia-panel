import { useCallback, useEffect, useState } from 'react';
import { Globe, Loader2 } from 'lucide-react';
import { api } from '../../api';
import type { PanelIpStatus } from '../../types';
import { useFeedback } from '../ui/feedback-context';

/**
 * IP-адрес панели (docs/security.md#panel-ip): какой адрес панель считает своим, что от него зависит, обнаруженная смена
 * и перевод всего на новый адрес одной кнопкой (или автоматически).
 */
export function PanelIpCard() {
  const { confirm, toast, alert } = useFeedback();
  const [status, setStatus] = useState<PanelIpStatus | null>(null);
  const [ip, setIp] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.getPanelIp();
      setStatus(next);
      setIp((current) => current || next.detected || next.known || '');
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  if (!status) return null;

  const uses = [
    status.uses.cloudflare_domain && `A-запись домена ${status.uses.cloudflare_domain} в Cloudflare`,
    status.uses.bridges > 0 && `пересылка «Панели через мост» на ${status.uses.bridges} мост(ах)`,
    status.uses.failover_domain && `прямой адрес в резервном домене ${status.uses.failover_domain}`,
    status.uses.public_url_by_ip && 'публичный адрес панели (ссылки подписок по IP)',
    status.uses.certificate_ip && 'самоподписанный сертификат HTTPS на этот IP (будет перевыпущен)',
  ].filter(Boolean) as string[];

  const apply = async () => {
    const target = ip.trim();
    if (!(await confirm({
      title: `Перевести панель на ${target}?`,
      message: uses.length
        ? `Будет обновлено: ${uses.join('; ')}. Записи, изменённые вне панели, не трогаются.`
        : 'От IP панели пока ничего не зависит — адрес просто сохранится.',
      confirmLabel: 'Обновить везде',
    }))) return;
    setBusy(true);
    try {
      const result = await api.applyPanelIp(target);
      await alert(
        result.steps.map((s) => `${s.ok ? '✅' : '❌'} ${s.title}\n    ${s.detail}`).join('\n'),
        `IP панели: ${result.previous ?? '—'} → ${result.ip}`,
      );
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось обновить IP панели', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleAuto = async (auto: boolean) => {
    setBusy(true);
    try {
      setStatus(await api.setPanelIpAuto(auto));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось сохранить настройку', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="panel-ip-title" className="bg-card border border-line rounded-2xl p-4 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id="panel-ip-title" className="flex items-center gap-2 text-base font-semibold text-ink">
            <Globe className="w-4 h-4 text-brand" /> IP-адрес панели
          </h3>
          <p className="text-xs text-muted">
            На этот адрес указывают домен панели в Cloudflare, мосты с «Панелью через мост» и резервный домен. Панель раз в 10 минут
            сверяет его с фактическим и предупредит, если он изменился.
          </p>
        </div>
        {busy && <Loader2 className="w-4 h-4 animate-spin text-info" />}
      </div>

      {status.dns_pending && (
        <p role="alert" className="p-3 bg-bad-soft text-bad rounded-lg text-xs">
          Домен панели в Cloudflare ещё ведёт на старый IP: перевод на <span className="font-mono">{status.dns_pending}</span> не удался.
          Нажмите «Обновить везде» ещё раз или исправьте A-запись в Cloudflare вручную.
        </p>
      )}
      {status.changed && status.detected && (
        <p role="alert" className="p-3 bg-warn-soft text-warn rounded-lg text-xs">
          IP панели изменился: был <span className="font-mono">{status.known}</span>, сейчас <span className="font-mono">{status.detected}</span>.
          Пока адрес не обновлён, домен, мосты и резервный домен ведут на старый.
        </p>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        <div className="bg-paper border border-line rounded-lg px-3 py-2">
          <dt className="text-faint">Адрес в настройках</dt>
          <dd className="font-mono text-ink">{status.known ?? 'не задан'}</dd>
        </div>
        <div className="bg-paper border border-line rounded-lg px-3 py-2">
          <dt className="text-faint">Зависит от адреса</dt>
          <dd className="text-ink">{uses.length ? uses.join('; ') : 'ничего'}</dd>
        </div>
      </dl>

      <fieldset disabled={busy} className="space-y-3 min-w-0 disabled:opacity-50">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <label className="flex-1 text-xs text-muted">
            Новый IPv4 панели
            <input
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              inputMode="decimal"
              placeholder="203.0.113.10"
              className="mt-1 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm font-mono text-ink focus:border-brand"
            />
          </label>
          <button
            type="button"
            disabled={!ip.trim() || (ip.trim() === status.known && !status.dns_pending)}
            onClick={() => void apply()}
            className="bg-brand text-on-accent font-bold text-sm px-4 py-2 rounded-lg btn-press disabled:opacity-50"
          >
            Обновить везде
          </button>
        </div>
        <label className="flex items-start gap-2 text-xs text-ink">
          <input type="checkbox" className="mt-0.5" checked={status.auto} onChange={(e) => void toggleAuto(e.target.checked)} />
          <span>
            Обновлять автоматически — после двух проверок подряд с одним и тем же новым адресом (около 20 минут). Выключено по умолчанию:
            если сервер выходит в интернет через другой адрес, чем принимает подключения, автоматика направила бы домен не туда.
          </span>
        </label>
      </fieldset>
    </section>
  );
}
