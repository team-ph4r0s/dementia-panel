import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Waypoints, RefreshCw, Pencil, Trash2, Terminal, Loader2, Save, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { Bridge, BridgeLinkMode, Server } from '../types';
import { api } from '../api';
import { countryFlag, countryName } from '../utils';
import { BridgeModal } from './BridgeModal';
import { useFeedback } from './ui/feedback-context';

const STATUS: Record<Bridge['status'], { label: string; className: string }> = {
  online: { label: 'работает', className: 'bg-ok-soft text-ok' },
  offline: { label: 'недоступен', className: 'bg-bad-soft text-bad' },
  error: { label: 'ошибка', className: 'bg-bad-soft text-bad' },
  installing: { label: 'установка', className: 'bg-info-soft text-info' },
  uninstalled: { label: 'не установлен', className: 'bg-soft text-muted' },
};

const MODES: { value: BridgeLinkMode; label: string }[] = [
  { value: 'auto', label: 'Авто — при недоступности' },
  { value: 'always', label: 'Всегда через мост' },
  { value: 'off', label: 'Не использовать' },
];

const selectClass = 'bg-paper border border-line rounded-xl px-2.5 py-1.5 text-ink focus:outline-none focus:border-brand transition text-xs';

/**
 * Привязка нод к мосту: какие ноды и в каком режиме. Изменения применяются на мосту одной кнопкой.
 */
const BridgeLinks: React.FC<{ bridge: Bridge; servers: Server[]; onChanged: () => void }> = ({ bridge, servers, onChanged }) => {
  const initial = useCallback(() => Object.fromEntries(bridge.links.map((l) => [l.server_id, l.mode])) as Record<number, BridgeLinkMode>, [bridge.links]);
  const [modes, setModes] = useState<Record<number, BridgeLinkMode>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Фоновое обновление не затирает несохранённую правку
  useEffect(() => {
    if (!dirty) void Promise.resolve().then(() => setModes(initial()));
  }, [initial, dirty]);

  const linkable = servers.filter((s) => !s.host.includes(':') || modes[s.id]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setBridgeLinks(
        bridge.id,
        Object.entries(modes).map(([id, mode]) => ({ server_id: Number(id), mode }))
      );
      setDirty(false);
    } catch (err: any) {
      setError(err.message);
      setDirty(false);
    } finally {
      setSaving(false);
      onChanged();
    }
  };

  return (
    <div className="space-y-2 min-w-0">
      <div className="border border-line rounded-xl overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs text-left">
          <thead className="bg-paper text-muted">
            <tr>
              <th className="p-2.5 font-medium">Нода</th>
              <th className="p-2.5 font-medium">Порт моста</th>
              <th className="p-2.5 font-medium">Режим</th>
              <th className="p-2.5 font-medium">Сейчас</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line bg-paper">
            {linkable.map((s) => {
              const link = bridge.links.find((l) => l.server_id === s.id);
              const mode = modes[s.id];
              return (
                <tr key={s.id} className={mode ? '' : 'opacity-60'}>
                  <td className="p-2.5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(mode)}
                        onChange={(e) => {
                          const next = { ...modes };
                          if (e.target.checked) next[s.id] = 'auto';
                          else delete next[s.id];
                          setModes(next);
                          setDirty(true);
                        }}
                      />
                      <span className="text-ink font-medium">{s.name}</span>
                    </label>
                    <div className="text-xs font-mono text-faint pl-6">{s.host}:{s.awg_port}</div>
                  </td>
                  <td className="p-2.5 font-mono text-muted">{link ? link.listen_port : mode ? 'будет выбран' : '—'}</td>
                  <td className="p-2.5">
                    {mode && (
                      <select
                        value={mode}
                        onChange={(e) => {
                          setModes({ ...modes, [s.id]: e.target.value as BridgeLinkMode });
                          setDirty(true);
                        }}
                        className={selectClass}
                      >
                        {MODES.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="p-2.5">
                    {link && <LinkState bridge={bridge} link={link} />}
                  </td>
                </tr>
              );
            })}
            {linkable.length === 0 && (
              <tr>
                <td colSpan={4} className="p-3 text-faint">
                  Нод пока нет.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      {dirty && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 bg-brand disabled:opacity-50 text-on-accent font-bold text-xs px-4 py-2 rounded-lg btn-press"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Применить на мосту
          </button>
        </div>
      )}
    </div>
  );
};

const LinkState: React.FC<{ bridge: Bridge; link: Bridge['links'][number] }> = ({ bridge, link }) => {
  const flag = countryFlag(bridge.country);
  const via = link.mode === 'always' || (link.mode === 'auto' && link.active);
  const broken = link.check_ok === false;
  return (
    <div className="space-y-0.5">
      {link.mode === 'off' ? (
        <span className="text-faint">не используется</span>
      ) : bridge.status !== 'online' ? (
        <span className="text-faint" title="Подписка выдаёт мост, только пока он работает">
          {flag} напрямую — мост не работает
        </span>
      ) : broken ? (
        <span className="inline-flex items-center gap-1 text-bad" title="Панель не получила ответ заглушки ноды через мост — мост не выдаётся">
          <XCircle className="w-3.5 h-3.5" /> пересылка не работает
        </span>
      ) : via ? (
        <span className="inline-flex items-center gap-1 text-warn" title={link.changed_at ? `с ${new Date(link.changed_at).toLocaleString()}` : undefined}>
          <Waypoints className="w-3.5 h-3.5" /> {flag} через мост
          {link.mode === 'auto' && <span className="text-faint">({link.reason === 'clients' ? 'обрыв у клиентов' : 'недоступна из страны'})</span>}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-ok">
          <CheckCircle2 className="w-3.5 h-3.5" /> {flag} напрямую
        </span>
      )}
      {link.check_ok === true && link.checked_at && (
        <div className="text-xs text-faint">пересылка проверена {new Date(link.checked_at).toLocaleString()}</div>
      )}
    </div>
  );
};

/**
 * Раздел «Мосты» (docs/bridges.md): серверы в странах пользователей, через которые подписка выдаёт ноды, недоступные напрямую.
 */
export const BridgesView: React.FC<{ servers: Server[] }> = ({ servers }) => {
  const { confirm } = useFeedback();
  const [bridges, setBridges] = useState<Bridge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ open: boolean; bridge: Bridge | null }>({ open: false, bridge: null });
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string; log?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setBridges(await api.getBridges());
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (id: number, fn: () => Promise<void>) => {
    setBusy(id);
    setNotice(null);
    try {
      await fn();
    } catch (err: any) {
      setNotice({ type: 'error', text: err.message });
    } finally {
      setBusy(null);
      load();
    }
  };

  const handleInstall = (b: Bridge) =>
    act(b.id, async () => {
      const result = await api.installBridge(b.id);
      setNotice(result.success ? { type: 'success', text: `Мост «${b.name}» установлен.` } : { type: 'error', text: result.error ?? 'Ошибка установки', log: result.log });
    });

  const handleTest = (b: Bridge) =>
    act(b.id, async () => {
      const result = await api.testBridgeSsh(b.id);
      setNotice({ type: result.success ? 'success' : 'error', text: result.success ? `SSH-подключение к «${b.name}» работает.` : result.message ?? 'SSH недоступен' });
    });

  const handleDelete = async (b: Bridge) => {
    if (!(await confirm({ message: `Удалить мост «${b.name}»? Пользователи, получавшие ноды через него, получат прямые адреса при обновлении подписки.`, danger: true, confirmLabel: 'Удалить' }))) return;
    const teardown = b.status !== 'uninstalled' && (await confirm({ title: 'Убрать правила пересылки?', message: 'Убрать правила пересылки с сервера моста? «Не убирать» — удалить только из панели.', confirmLabel: 'Убрать правила', cancelLabel: 'Не убирать' }));
    act(b.id, async () => {
      try {
        await api.deleteBridge(b.id, { teardown });
      } catch (err: any) {
        if (!teardown || !(await confirm({ message: `${err.message}\n\nУдалить мост из панели всё равно?`, danger: true, confirmLabel: 'Удалить' }))) throw err;
        await api.deleteBridge(b.id, { teardown, force: true });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1 max-w-3xl">
          <h1 className="font-display text-2xl font-extrabold text-ink tracking-tight">Мосты</h1>
          <p className="text-sm text-muted">
            Мост — сервер в стране пользователей, через который они подключаются к зарубежной ноде, когда напрямую она недоступна.
            Мост только пересылает трафик AmneziaWG: шифрование сквозное, ключей пользователей на нём нет. Подписка пользователя,
            у которого задана страна, сама выдаст адрес моста этой страны, если проверка доступности из неё не проходит или у клиентов
            этой страны одновременно оборвались подключения к ноде.
          </p>
        </div>
        <button
          onClick={() => setModal({ open: true, bridge: null })}
          className="flex items-center gap-1.5 bg-brand text-on-accent font-bold text-sm px-4 py-2 rounded-lg btn-press"
        >
          <Plus className="w-4 h-4" /> Мост
        </button>
      </div>

      {notice && (
        <div className={`p-3 rounded-xl border border-line text-xs ${notice.type === 'success' ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}>
          {notice.text}
          {notice.log && <pre className="mt-2 max-h-40 overflow-auto text-xs text-muted whitespace-pre-wrap">{notice.log}</pre>}
        </div>
      )}
      {error && <div className="p-3 rounded-xl border border-line bg-bad-soft text-bad text-xs">{error}</div>}

      {!bridges ? (
        <div className="text-sm text-faint flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Загрузка...
        </div>
      ) : bridges.length === 0 ? (
        <div className="bg-card border border-line rounded-2xl p-8 text-center space-y-3">
          <Waypoints className="w-10 h-10 text-info mx-auto" />
          <p className="text-sm text-ink font-semibold">Мостов пока нет</p>
          <p className="text-xs text-muted max-w-xl mx-auto">
            Добавьте сервер в стране пользователей (арендованный VPS) и привяжите к нему зарубежные ноды. Затем укажите страну у
            пользователей и включите проверку доступности нод из этой страны на вкладке «Серверы».
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {bridges.map((b) => {
            const status = STATUS[b.status];
            return (
              <div key={b.id} className="bg-card border border-line rounded-2xl p-5 space-y-4 min-w-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xl leading-none" title={countryName(b.country)}>
                        {countryFlag(b.country)}
                      </span>
                      <h3 className="font-display text-lg font-bold text-ink">{b.name}</h3>
                      <span className={`text-xs font-semibold rounded-full px-2.5 py-0.5 ${status.className}`}>{b.installing ? STATUS.installing.label : status.label}</span>
                    </div>
                    <div className="text-xs font-mono text-faint">
                      {b.ssh_user}@{b.host}:{b.ssh_port} · {countryName(b.country)}
                    </div>
                    {b.last_error && (
                      <div className="text-xs text-bad flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {b.last_error}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {busy === b.id && <Loader2 className="w-4 h-4 animate-spin text-info" />}
                    <button onClick={() => handleInstall(b)} disabled={busy !== null} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-line bg-soft hover:bg-soft-2 text-ink disabled:opacity-40">
                      <RefreshCw className="w-3.5 h-3.5" /> {b.status === 'uninstalled' || b.status === 'error' ? 'Установить' : 'Переустановить'}
                    </button>
                    <button onClick={() => handleTest(b)} disabled={busy !== null} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-line bg-soft hover:bg-soft-2 text-ink disabled:opacity-40">
                      <Terminal className="w-3.5 h-3.5" /> Тест SSH
                    </button>
                    <button onClick={() => setModal({ open: true, bridge: b })} className="p-2 rounded-full border border-line bg-soft hover:bg-soft-2 text-muted" title="Настройки">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDelete(b)} disabled={busy !== null} className="p-2 rounded-full border border-line bg-soft hover:bg-bad-soft text-bad disabled:opacity-40" title="Удалить">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <BridgeLinks bridge={b} servers={servers} onChanged={load} />
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-faint max-w-4xl">
        «Авто»: мост выдаётся пользователям страны моста, если две проверки подряд показали, что из этой страны нода недоступна, или если у
        нескольких клиентов этой страны одновременно оборвались подключения, а у остальных нет. Возврат на прямой адрес — после трёх
        удачных проверок и не раньше чем через 12 часов. «Всегда через мост» — для случаев, которые проверки не видят (например, нестабильный
        маршрут у части операторов связи). Изменение адреса доходит до пользователя при обновлении подписки в приложении; выданные вручную
        файлы .conf не меняются.
      </p>

      <BridgeModal isOpen={modal.open} bridge={modal.bridge} servers={servers} onClose={() => setModal({ open: false, bridge: null })} onSaved={load} />
    </div>
  );
};
