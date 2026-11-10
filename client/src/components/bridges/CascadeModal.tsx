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
  const [auto, setAuto] = useState(true);
  const [sni, setSni] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (value: number | 'auto' | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.setBridgeCascade(bridge.id, link.server_id, value, link.cascade_port ? undefined : sni.trim() || undefined);
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
        void apply(link.cascade_port ?? (auto ? 'auto' : Number(port)));
      }}>
        <h2 className="text-lg font-bold text-ink">Каскад XHTTP</h2>
        <p className="text-sm text-muted">{bridge.name} → {link.server_name}</p>
        <p className="text-sm text-muted">
          Панель установит отдельный Xray на мосту и ноде. Клиенты продолжат подключаться к порту моста {link.listen_port}.
          Между мостом и нодой VPN-трафик пойдёт внутри VLESS XHTTP Reality.
        </p>
        <p className="text-sm text-muted">
          На ноде нужен запущенный Docker. Панель установит недостающие зависимости на мосту. Порт на ноде панель подберёт сама (его никто не слушает,
          он не занят другими нодами панели) и откроет в ufw или firewalld, если они включены. Фаервол у хостинг-провайдера открывайте вручную,
          а на мосту проверьте, что его клиентский порт доступен.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
          <li>Оставьте автоподбор порта или укажите свой свободный TCP-порт на ноде. Если у хостинга есть внешний фаервол, откройте выбранный порт в нём.</li>
          <li>Убедитесь, что клиентский порт моста {link.listen_port} открыт на мосту.</li>
          <li>Сайт маскировки можно не указывать: панель выберет его сама.</li>
        </ol>
        {!link.cascade_port && (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={auto} disabled={busy} onChange={(event) => setAuto(event.target.checked)} />
            <span>Подобрать свободный порт автоматически</span>
          </label>
        )}
        {(link.cascade_port || !auto) && (
          <label className="block space-y-1 text-sm text-ink">
            <span>TCP-порт каскада на ноде</span>
            <input
              type="number" required min={1} max={65535} value={link.cascade_port ?? port} disabled={busy || Boolean(link.cascade_port)}
              onChange={(event) => setPort(event.target.value)}
              className="block min-h-10 w-full rounded-lg border border-line bg-paper px-3 font-mono text-ink"
            />
          </label>
        )}
        {!link.cascade_port && (
          <label className="block space-y-1 text-sm text-ink">
            <span>Сайт маскировки Reality (необязательно)</span>
            <input
              type="text" value={sni} disabled={busy} placeholder="выберет панель"
              onChange={(event) => setSni(event.target.value)}
              className="block min-h-10 w-full rounded-lg border border-line bg-paper px-3 font-mono text-ink"
            />
            <span className="block text-xs text-muted">
              Это чужой популярный сайт (например, dl.google.com), под который Reality маскирует трафик, а не ваш домен и не домен панели.
              Нужен TLS 1.3 и HTTP/2, и он должен открываться с ноды по TCP 443. Ничего не указывайте, если не уверены. Сменить его позже можно, только отключив каскад.
            </span>
          </label>
        )}
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
