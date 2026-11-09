import { useId, useState } from 'react';
import { api } from '../api';
import type { Server } from '../types';
import { useFeedback } from './ui/feedback-context';

/**
 * Запасные UDP-порты ноды AmneziaWG: правило на сервере пересылает их на основной порт, а в подписке каждый порт —
 * отдельная запись. Нужны, когда блокируют пару «адрес:порт»: менять основной порт (и рвать всех клиентов) не приходится.
 */
export function NodeExtraPorts({ server, readOnly, onChanged }: { server: Server; readOnly?: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useFeedback();
  const title = useId();

  if (server.protocol !== 'awg' || server.remote_panel_id) return null;
  const ports = server.extra_ports ?? [];
  const active = server.extra_ports_active ?? [];
  const installed = server.status !== 'uninstalled';

  if (draft === null || readOnly) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">Запасные порты</span>
        {ports.length === 0 && <span className="text-ink">нет</span>}
        {ports.map((port) => (
          <span
            key={port}
            title={active.includes(port) ? 'Пересылается на ноде и выдаётся в подписке' : installed ? 'Ещё не применён на ноде — в подписку не попадает' : 'Нода не установлена'}
            className={`font-mono px-2 py-0.5 rounded-lg border border-line ${active.includes(port) ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
          >
            {port}/udp
          </span>
        ))}
        {server.extra_ports_error && <span className="text-bad">{server.extra_ports_error}</span>}
        {!readOnly && <button type="button" onClick={() => setDraft(ports.join(', '))} className="text-brand hover:underline">Изменить</button>}
      </div>
    );
  }

  return (
    <form aria-labelledby={title} className="space-y-2" onSubmit={async (event) => {
      event.preventDefault();
      const list = draft.split(/[\s,;]+/).filter(Boolean);
      if (list.some((item) => !/^\d{1,5}$/.test(item))) {
        toast('Порты — числа через запятую, например: 443, 53', 'error');
        return;
      }
      setBusy(true);
      try {
        await api.updateServerExtraPorts(server.id, list.map(Number));
        setDraft(null);
        onChanged();
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Ошибка сохранения запасных портов', 'error');
        onChanged();
      } finally {
        setBusy(false);
      }
    }}>
      <div id={title} className="text-xs text-muted">Запасные порты (UDP, до 4, через запятую)</div>
      <fieldset disabled={busy} className="flex flex-wrap items-center gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="443, 53"
          aria-label="Запасные порты"
          className="bg-paper border border-line rounded-lg p-2 text-xs text-ink font-mono w-48 focus:outline-none focus:border-brand"
        />
        <button type="submit" className="bg-brand text-on-accent rounded-lg px-3 py-2 text-xs font-semibold btn-press">{busy ? 'Применение…' : 'Сохранить'}</button>
        <button type="button" onClick={() => setDraft(null)} className="text-xs text-muted hover:text-ink">Отмена</button>
      </fieldset>
      <p className="text-xs text-faint">
        Сервер пересылает эти порты на основной ({server.awg_port}/udp); AmneziaWG не перезапускается. В подписке каждый порт —
        отдельная запись «{server.name} · порт N». Если у сервера есть внешний фаервол (группа безопасности у хостера), откройте порты и там.
      </p>
    </form>
  );
}
