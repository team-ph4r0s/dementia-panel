import React, { useState } from 'react';
import { X, Server, Key, Lock, Shield } from 'lucide-react';
import { api } from '../api';
import { AmneziaImportPanel } from './AmneziaImportPanel';
import type { Server as ServerType, ServerUpdate } from '../types';
import { useFeedback } from './ui/feedback-context';
import { ModalShell } from './ui/Modal';

interface AddServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onServerAdded: (server: ServerType) => void;
  /** Если задан — окно работает в режиме редактирования */
  editingServer?: ServerType | null;
  onServerUpdated?: (server: ServerType) => void;
  /** Серверы импортированы из AmneziaVPN — список нужно перезагрузить */
  onImported?: () => void;
}

export const AddServerModal: React.FC<AddServerModalProps> = ({
  isOpen,
  onClose,
  onServerAdded,
  editingServer = null,
  onServerUpdated,
  onImported,
}) => {
  const { confirm } = useFeedback();
  const [mode, setMode] = useState<'manual' | 'amnezia'>('manual');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [authType, setAuthType] = useState<'password' | 'key'>('password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [awgPort, setAwgPort] = useState('51820');
  const [subnet, setSubnet] = useState('10.8.0.1/24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetHostKey, setResetHostKey] = useState(false);

  const editing = Boolean(editingServer);
  const hasClients = (editingServer?.client_count || 0) > 0;

  // Заполнение формы при каждом открытии (без устаревших значений от прошлого раза). Сброс — во время рендера при смене
  // «ключа открытия», а не в эффекте: форма не мигает прежними значениями, а фоновое обновление списка серверов (новый объект
  // editingServer с тем же id) не затирает ввод пользователя
  const openKey = isOpen ? `open:${editingServer?.id ?? 'new'}` : 'closed';
  const [filledFor, setFilledFor] = useState('closed');
  if (filledFor !== openKey) {
    setFilledFor(openKey);
    if (isOpen) {
      setName(editingServer?.name ?? '');
      setHost(editingServer?.host ?? '');
      setSshPort(String(editingServer?.ssh_port ?? 22));
      setSshUser(editingServer?.ssh_user ?? 'root');
      setAuthType(editingServer?.has_ssh_key ? 'key' : 'password');
      setSshPassword('');
      setSshKey('');
      setAwgPort(String(editingServer?.awg_port ?? 51820));
      setSubnet(editingServer?.subnet ?? '10.8.0.1/24');
      setResetHostKey(false);
      setError(null);
      setMode('manual');
    }
  }

  if (!isOpen) return null;

  const currentAuth = editingServer?.has_ssh_key ? 'key' : 'password';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (editingServer) {
        const update: ServerUpdate = {
          name,
          host,
          ssh_port: parseInt(sshPort, 10),
          ssh_user: sshUser,
          awg_port: parseInt(awgPort, 10),
          subnet,
        };
        // Пустое поле — оставить текущий секрет; смена способа требует нового значения
        const secret = authType === 'password' ? sshPassword : sshKey;
        if (secret || authType !== currentAuth) {
          update.auth_type = authType;
          if (authType === 'password') update.ssh_password = sshPassword;
          else update.ssh_key = sshKey;
        }
        if (resetHostKey) update.reset_host_key = true;
        if (update.awg_port !== editingServer.awg_port && editingServer.status !== 'uninstalled') {
          if (!(await confirm('Смена порта пересоздаст контейнер AmneziaWG на сервере, а клиентам потребуется обновить конфигурацию. Продолжить?'))) {
            setLoading(false);
            return;
          }
        }
        const updated = await api.updateServer(editingServer.id, update);
        onServerUpdated?.(updated);
        onClose();
        return;
      }

      const server = await api.createServer({
        name,
        host,
        ssh_port: parseInt(sshPort, 10) || 22,
        ssh_user: sshUser,
        ssh_password: authType === 'password' ? sshPassword : undefined,
        ssh_key: authType === 'key' ? sshKey : undefined,
        awg_port: parseInt(awgPort, 10) || 51820,
        subnet,
      });

      onServerAdded(server);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Ошибка создания сервера');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell label="Сервер" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-lg shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-card">
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-ok" />
            <h2 className="text-lg font-semibold text-ink">{editing ? 'Настройки сервера' : 'Добавить сервер'}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-muted hover:text-ink transition p-1 rounded-lg hover:bg-soft border border-line"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        {!editing && (
          <div className="px-6 pt-4">
            <div className="grid grid-cols-2 gap-2 p-1 bg-paper border border-line rounded-xl">
              {(['manual', 'amnezia'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`py-1.5 text-xs font-medium rounded-lg transition ${mode === m ? 'bg-soft text-ink' : 'text-muted hover:text-ink'}`}
                >
                  {m === 'manual' ? 'Вручную (SSH)' : 'Из AmneziaVPN (ключ)'}
                </button>
              ))}
            </div>
          </div>
        )}

        {!editing && mode === 'amnezia' ? (
          <AmneziaImportPanel onImported={() => onImported?.()} onClose={onClose} />
        ) : (
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {error && (
            <div className="p-3 bg-bad-soft border border-line rounded-xl text-bad text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Название сервера
            </label>
            <input
              type="text"
              required
              placeholder="например: Frankfurt-01"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted mb-1">
                IP адрес / Хост
              </label>
              <input
                type="text"
                required
                placeholder="194.87.12.34"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">
                SSH Порт
              </label>
              <input
                type="number"
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink focus:outline-none focus:border-brand transition text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Пользователь SSH
            </label>
            <input
              type="text"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink focus:outline-none focus:border-brand transition text-sm"
            />
          </div>

          {/* Auth Type Tabs */}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">
              Аутентификация SSH
            </label>
            <div className="grid grid-cols-2 gap-2 p-1 bg-paper border border-line rounded-xl mb-3">
              <button
                type="button"
                onClick={() => setAuthType('password')}
                className={`flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-lg transition ${
                  authType === 'password'
                    ? 'bg-soft text-ink'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                Пароль
              </button>
              <button
                type="button"
                onClick={() => setAuthType('key')}
                className={`flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-lg transition ${
                  authType === 'key'
                    ? 'bg-soft text-ink'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <Key className="w-3.5 h-3.5" />
                SSH Ключ
              </button>
            </div>

            {authType === 'password' ? (
              <input
                type="password"
                placeholder={editing && editingServer?.has_ssh_password ? 'Оставьте пустым, чтобы не менять' : 'Введите пароль SSH'}
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm"
              />
            ) : (
              <textarea
                rows={3}
                placeholder={editing && editingServer?.has_ssh_key ? 'Оставьте пустым, чтобы не менять ключ' : 'Вставьте приватный ключ (-----BEGIN OPENSSH PRIVATE KEY-----)'}
                value={sshKey}
                onChange={(e) => setSshKey(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition font-mono text-xs"
              />
            )}
          </div>

          {/* AmneziaWG Network Settings */}
          <div className="pt-2 border-t border-line">
            <div className="flex items-center gap-1.5 text-xs font-medium text-ok mb-2">
              <Shield className="w-3.5 h-3.5" />
              <span>Параметры AmneziaWG</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Порт протокола (UDP)
                </label>
                <input
                  type="number"
                  value={awgPort}
                  onChange={(e) => setAwgPort(e.target.value)}
                  className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink focus:outline-none focus:border-brand transition text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Подсеть клиентов
                </label>
                <input
                  type="text"
                  value={subnet}
                  disabled={editing && hasClients}
                  title={editing && hasClients ? 'Подсеть нельзя менять, пока на сервере есть клиенты' : undefined}
                  onChange={(e) => setSubnet(e.target.value)}
                  className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink focus:outline-none focus:border-brand transition text-sm"
                />
              </div>
            </div>
            {!editing && (
              <p className="text-xs text-faint mt-2">
                * Заголовки обфускации (H1-H4, Jc, S1, S2) будут сгенерированы автоматически случайным образом.
              </p>
            )}
            {sshUser !== 'root' && (
              <p className="text-xs text-warn mt-2">
                * Для пользователя, отличного от root, нужен sudo без пароля (NOPASSWD).
              </p>
            )}
          </div>

          {editing && editingServer?.host_key && (
            <label className="flex items-start gap-2 text-xs text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={resetHostKey}
                onChange={(e) => setResetHostKey(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Сбросить сохранённый ключ SSH-хоста (<span className="font-mono">{editingServer.host_key.slice(0, 24)}…</span>).
                Только если сервер был переустановлен — иначе это может быть атака «человек посередине».
              </span>
            </label>
          )}
          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted hover:text-ink transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading}
              className="bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2 rounded-lg transition btn-press hover:text-on-accent"
            >
              {loading ? 'Сохранение...' : 'Сохранить сервер'}
            </button>
          </div>
        </form>
        )}
      </div>
    </ModalShell>
  );
};
