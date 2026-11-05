import React, { useEffect, useState } from 'react';
import { X, Waypoints, Lock, Key, CheckSquare, Square, Loader2 } from 'lucide-react';
import type { Bridge, BridgeInput, Server } from '../types';
import { api } from '../api';
import { CountrySelect } from './CountrySelect';
import { ModalShell } from './ui/Modal';

const inputClass =
  'w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm';

interface BridgeModalProps {
  isOpen: boolean;
  /** null — новый мост */
  bridge: Bridge | null;
  servers: Server[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Добавление моста (сразу с установкой по SSH) и правка его доступа и страны.
 */
export const BridgeModal: React.FC<BridgeModalProps> = ({ isOpen, bridge, servers, onClose, onSaved }) => {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [authType, setAuthType] = useState<'password' | 'key'>('password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [country, setCountry] = useState('ru');
  const [serverIds, setServerIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);

  // Только свои ноды и ноды партнёров с адресом IPv4/доменом: IPv6 мост не пересылает
  const linkable = servers.filter((s) => !s.host.includes(':'));

  useEffect(() => {
    if (!isOpen) return;
    setName(bridge?.name ?? '');
    setHost(bridge?.host ?? '');
    setSshPort(String(bridge?.ssh_port ?? 22));
    setSshUser(bridge?.ssh_user ?? 'root');
    setAuthType(bridge?.has_ssh_key ? 'key' : 'password');
    setSshPassword('');
    setSshKey('');
    setCountry(bridge?.country ?? 'ru');
    setServerIds(linkable.filter((s) => s.status === 'online').map((s) => s.id));
    setError(null);
    setLog(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, bridge?.id]);

  if (!isOpen) return null;

  const toggle = (id: number) => setServerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLog(null);
    const data: BridgeInput = { name: name.trim(), host: host.trim(), ssh_port: Number(sshPort) || 22, ssh_user: sshUser.trim() || 'root', country };
    if (authType === 'password' && sshPassword) data.ssh_password = sshPassword;
    if (authType === 'key' && sshKey.trim()) data.ssh_key = sshKey;
    setLoading(true);
    try {
      if (bridge) {
        await api.updateBridge(bridge.id, data);
        onSaved();
        onClose();
        return;
      }
      const result = await api.createBridge({ ...data, links: serverIds.map((id) => ({ server_id: id, mode: 'auto' })) });
      onSaved();
      if (result.success) {
        onClose();
      } else {
        // Мост добавлен, но установка не удалась: показываем причину и журнал, переустановить можно с карточки
        setError(`Мост добавлен, но установка не удалась: ${result.error}`);
        setLog(result.log ?? null);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell label="Мост" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-lg shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-card">
          <div className="flex items-center gap-2">
            <Waypoints className="w-5 h-5 text-ok" />
            <h2 className="text-lg font-semibold text-ink">{bridge ? 'Настройки моста' : 'Добавить мост'}</h2>
          </div>
          <button onClick={onClose} aria-label="Закрыть" className="text-muted hover:text-ink transition p-1 rounded-lg hover:bg-soft border border-line">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {error && <div className="p-3 bg-bad-soft border border-line rounded-xl text-bad text-sm">{error}</div>}
          {log && <pre className="max-h-40 overflow-auto p-3 bg-paper border border-line rounded-xl text-xs text-muted whitespace-pre-wrap">{log}</pre>}

          {!bridge && (
            <p className="text-xs text-muted">
              Мост — сервер в стране пользователей. Он пересылает трафик AmneziaWG на зарубежную ноду: шифрование остаётся сквозным,
              ключей пользователей на мосту нет. Docker не нужен — панель настроит пересылку пакетов (iptables) по SSH.
            </p>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted mb-1">Название</label>
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="например: Москва-01" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Страна</label>
              <CountrySelect value={country} onChange={setCountry} className={inputClass} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted mb-1">IP адрес / Хост</label>
              <input required value={host} onChange={(e) => setHost(e.target.value)} placeholder="95.163.12.34" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">SSH Порт</label>
              <input type="number" value={sshPort} onChange={(e) => setSshPort(e.target.value)} className={inputClass} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">Пользователь SSH</label>
            <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} className={inputClass} />
          </div>

          <div>
            <div className="grid grid-cols-2 gap-2 p-1 bg-paper border border-line rounded-xl mb-3">
              {(['password', 'key'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAuthType(t)}
                  className={`flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-lg transition ${authType === t ? 'bg-soft text-ink' : 'text-muted hover:text-ink'}`}
                >
                  {t === 'password' ? <Lock className="w-3.5 h-3.5" /> : <Key className="w-3.5 h-3.5" />}
                  {t === 'password' ? 'Пароль' : 'SSH Ключ'}
                </button>
              ))}
            </div>
            {authType === 'password' ? (
              <input
                type="password"
                required={!bridge}
                placeholder={bridge?.has_ssh_password ? 'Оставьте пустым, чтобы не менять' : 'Введите пароль SSH'}
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
                className={inputClass}
              />
            ) : (
              <textarea
                rows={3}
                required={!bridge}
                placeholder={bridge?.has_ssh_key ? 'Оставьте пустым, чтобы не менять ключ' : 'Вставьте приватный ключ (-----BEGIN OPENSSH PRIVATE KEY-----)'}
                value={sshKey}
                onChange={(e) => setSshKey(e.target.value)}
                className={`${inputClass} font-mono text-xs`}
              />
            )}
            {sshUser !== 'root' && <p className="text-xs text-warn mt-2">* Для пользователя, отличного от root, нужен sudo без пароля (NOPASSWD).</p>}
          </div>

          {!bridge && (
            <div>
              <label className="block text-xs font-medium text-ink mb-2">Ноды, к которым ведёт мост</label>
              {linkable.length === 0 ? (
                <p className="text-xs text-faint">Нод пока нет — привязать их можно позже на карточке моста.</p>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                  {linkable.map((s) => {
                    const checked = serverIds.includes(s.id);
                    return (
                      <div
                        key={s.id}
                        onClick={() => toggle(s.id)}
                        className={`flex items-center gap-3 p-2.5 rounded-xl border border-line cursor-pointer select-none ${checked ? 'bg-soft text-ink' : 'bg-paper text-muted'}`}
                      >
                        {checked ? <CheckSquare className="w-4 h-4 text-ok" /> : <Square className="w-4 h-4 text-faint" />}
                        <span className="text-sm">{s.name}</span>
                        <span className="ml-auto text-xs font-mono text-faint">{s.host}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-ink transition">
              {log ? 'Закрыть' : 'Отмена'}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2 rounded-lg transition btn-press"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? (bridge ? 'Сохранение...' : 'Установка...') : bridge ? 'Сохранить' : 'Добавить и установить'}
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
};
