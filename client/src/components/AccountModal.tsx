import React, { useState } from 'react';
import { X, Lock, Check, User, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { AdminUser } from '../types';
import { TwoFactorCard } from './TwoFactorCard';
import { SessionsCard } from './SessionsCard';
import { ModalShell } from './ui/Modal';

interface AccountModalProps {
  isOpen: boolean;
  user: AdminUser | null;
  onClose: () => void;
  onUsernameChanged: (user: AdminUser) => void;
}

type AccountTab = 'password' | 'username' | 'security';

const inputClass =
  'w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink focus:outline-none focus:border-brand text-sm';
const labelClass = 'block text-xs font-medium text-muted mb-1';

export const AccountModal: React.FC<AccountModalProps> = ({ isOpen, user, onClose, onUsernameChanged }) => {
  const [tab, setTab] = useState<AccountTab>('password');

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [usernamePassword, setUsernamePassword] = useState('');
  const [newUsername, setNewUsername] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (!isOpen) return null;

  const switchTab = (next: AccountTab) => {
    setTab(next);
    setError(null);
    setSuccess(null);
  };

  const finish = (message: string) => {
    setSuccess(message);
    setTimeout(() => {
      setSuccess(null);
      onClose();
    }, 1500);
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Новые пароли не совпадают');
      return;
    }
    if (newPassword.length < 8) {
      setError('Новый пароль должен содержать не менее 8 символов');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      await api.changePassword(oldPassword, newPassword);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      finish('Пароль успешно обновлен!');
    } catch (err: any) {
      setError(err.message || 'Ошибка смены пароля');
    } finally {
      setLoading(false);
    }
  };

  const handleUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const username = newUsername.trim();
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) {
      setError('Логин: от 1 до 64 символов — латинские буквы, цифры и . _ @ -');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const updated = await api.changeUsername(usernamePassword, username);
      onUsernameChanged(updated);
      setUsernamePassword('');
      setNewUsername('');
      finish('Логин изменён. Используйте его при следующем входе.');
    } catch (err: any) {
      setError(err.message || 'Ошибка смены логина');
    } finally {
      setLoading(false);
    }
  };

  const tabClass = (active: boolean) =>
    `flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition ${
      active ? 'bg-soft text-ink ' : 'text-muted hover:text-ink'
    }`;

  return (
    <ModalShell label="Учётная запись" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-md shadow-pop overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-card">
          <div className="flex items-center gap-2">
            <Lock className="w-5 h-5 text-ok" />
            <h2 className="text-base font-semibold text-ink">Учётная запись администратора</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-muted hover:text-ink transition p-1 rounded-lg hover:bg-soft border border-line"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pt-4">
          <div className="flex gap-1 bg-paper p-1 rounded-xl border border-line">
            <button type="button" onClick={() => switchTab('password')} className={tabClass(tab === 'password')}>
              <Lock className="w-3.5 h-3.5 text-ok" />
              <span>Пароль</span>
            </button>
            <button type="button" onClick={() => switchTab('username')} className={tabClass(tab === 'username')}>
              <User className="w-3.5 h-3.5 text-info" />
              <span>Логин</span>
            </button>
            <button type="button" onClick={() => switchTab('security')} className={tabClass(tab === 'security')}>
              <ShieldCheck className="w-3.5 h-3.5 text-warn" />
              <span>Защита</span>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="px-6 pt-4 space-y-3 empty:hidden">
          {error && (
            <div className="p-3 bg-bad-soft border border-line rounded-xl text-bad text-xs">{error}</div>
          )}
          {success && (
            <div className="p-3 bg-ok-soft border border-line rounded-xl text-ok text-xs flex items-center gap-2">
              <Check className="w-4 h-4" />
              <span>{success}</span>
            </div>
          )}
        </div>

        {tab === 'password' ? (
          <form onSubmit={handlePasswordSubmit} className="p-6 space-y-4">
            <div>
              <label className={labelClass}>Текущий пароль</label>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className={labelClass}>Новый пароль</label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className={labelClass}>Подтвердите новый пароль</label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputClass}
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-3">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-ink transition">
                Отмена
              </button>
              <button
                type="submit"
                disabled={loading || !!success}
                className="bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2 rounded-lg transition btn-press hover:text-on-accent"
              >
                {loading ? 'Сохранение...' : 'Обновить пароль'}
              </button>
            </div>
          </form>
        ) : tab === 'username' ? (
          <form onSubmit={handleUsernameSubmit} className="p-6 space-y-4">
            <div className="text-xs text-muted">
              Текущий логин: <span className="font-mono text-ink">{user?.username ?? '—'}</span>
            </div>

            <div>
              <label className={labelClass}>Новый логин</label>
              <input
                type="text"
                required
                maxLength={64}
                autoComplete="username"
                placeholder="латиница, цифры и . _ @ -"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label className={labelClass}>Текущий пароль (для подтверждения)</label>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={usernamePassword}
                onChange={(e) => setUsernamePassword(e.target.value)}
                className={inputClass}
              />
            </div>

            <p className="text-xs text-faint">
              Остальные сессии администратора будут завершены, в этой вы останетесь авторизованы.
            </p>

            <div className="flex items-center justify-end gap-3 pt-3">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-ink transition">
                Отмена
              </button>
              <button
                type="submit"
                disabled={loading || !!success}
                className="bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2 rounded-lg transition btn-press hover:text-on-accent"
              >
                {loading ? 'Сохранение...' : 'Сменить логин'}
              </button>
            </div>
          </form>
        ) : (
          <div className="p-6 space-y-6 overflow-y-auto max-h-[70vh]">
            <TwoFactorCard />
            <div className="border-t border-line pt-6"><SessionsCard /></div>
          </div>
        )}
      </div>
    </ModalShell>
  );
};
