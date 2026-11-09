import { useState } from 'react';
import { api } from '../../api';
import type { Bridge, BridgeLink } from '../../types';
import { ModalShell } from '../ui/Modal';

export function CascadeModal({ bridge, link, onClose, onChanged }: {
  bridge: Bridge;
  link: BridgeLink;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [port, setPort] = useState(String(link.cascade_port ?? 8443));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (value: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.setBridgeCascade(bridge.id, link.server_id, value);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось настроить каскад');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell label="Каскад XHTTP" onClose={() => { if (!busy) onClose(); }}>
      <form className="w-full max-w-lg space-y-4 rounded-2xl border border-line bg-card p-5" onSubmit={(event) => {
        event.preventDefault();
        void apply(link.cascade_port ?? Number(port));
      }}>
        <h2 className="text-lg font-bold text-ink">Каскад XHTTP</h2>
        <p className="text-sm text-muted">{bridge.name} → {link.server_name}</p>
        <p className="text-sm text-muted">
          Панель установит отдельный Xray на мосту и ноде. Клиенты продолжат подключаться к порту моста {link.listen_port}.
          Между мостом и нодой VPN-трафик пойдёт внутри VLESS XHTTP Reality.
        </p>
        <p className="text-sm text-muted">
          Нужен запущенный Docker на обоих серверах и conntrack с iproute2 на мосту. Разрешите в фаерволе ноды вход на выбранный TCP-порт с адреса моста,
          а на мосту проверьте, что его клиентский порт доступен.
        </p>
        <label className="block space-y-1 text-sm text-ink">
          <span>TCP-порт каскада на ноде</span>
          <input
            type="number" required min={1} max={65535} value={link.cascade_port ?? port} disabled={busy || Boolean(link.cascade_port)}
            onChange={(event) => setPort(event.target.value)}
            className="block min-h-10 w-full rounded-lg border border-line bg-paper px-3 font-mono text-ink"
          />
        </label>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="min-h-10 rounded-lg px-3 text-sm text-muted hover:bg-soft">Закрыть</button>
          {link.cascade_port && (
            <button type="button" disabled={busy} onClick={() => void apply(null)} className="min-h-10 rounded-lg border border-line px-3 text-sm text-bad hover:bg-bad-soft">
              Отключить каскад
            </button>
          )}
          <button type="submit" disabled={busy} className="min-h-10 rounded-lg bg-brand px-3 text-sm font-bold text-on-accent btn-press disabled:opacity-50">
            {busy ? 'Применение…' : link.cascade_port ? 'Применить снова' : 'Включить каскад'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
