import React, { useState } from 'react';
import { Lock, User, ArrowRight, Loader2 } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { api } from '../api';
import type { AdminUser } from '../types';

interface LoginViewProps {
  onLoginSuccess: (user: AdminUser) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await api.login(
        username.trim(),
        password,
        totpRequired && !useRecovery ? code : undefined,
        totpRequired && useRecovery ? code : undefined,
      );
      if ('totp_required' in res) {
        setTotpRequired(true);
        return;
      }
      onLoginSuccess(res.user);
    } catch (err: any) {
      setError(err.message || 'Неверный логин или пароль');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-page flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-line rounded-2xl p-8 shadow-pop relative overflow-hidden">
        {/* Логотип */}
        <div className="flex flex-col items-center text-center mb-8">
          <BrandMark className="w-14 h-14" />
          <h1 className="mt-4 text-2xl font-extrabold text-ink">dementia</h1>
          <p className="text-sm text-muted mt-1">Вход в панель управления AmneziaWG</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-bad-soft border border-line rounded-xl text-bad text-xs text-center animate-in fade-in">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">
              Имя пользователя
            </label>
            <div className="relative">
              <input
                type="text"
                required
                autoFocus
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl pl-10 pr-4 py-2.5 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm font-sans"
              />
              <User className="w-4 h-4 text-faint absolute left-3.5 top-3" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">
              Пароль администратора
            </label>
            <div className="relative">
              <input
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl pl-10 pr-4 py-2.5 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm font-sans"
              />
              <Lock className="w-4 h-4 text-faint absolute left-3.5 top-3" />
            </div>
          </div>

          {totpRequired && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">
                {useRecovery ? 'Код восстановления' : 'Код из приложения-аутентификатора'}
              </label>
              <input
                type="text"
                required
                autoFocus
                aria-label={useRecovery ? 'Код восстановления' : 'Код из приложения-аутентификатора'}
                autoComplete="one-time-code"
                inputMode={useRecovery ? 'text' : 'numeric'}
                maxLength={useRecovery ? 8 : 6}
                value={code}
                onChange={(e) => setCode(e.target.value.trim())}
                className="w-full bg-paper border border-line rounded-xl px-4 py-2.5 text-ink focus:outline-none focus:border-brand text-sm text-center tracking-widest font-mono"
              />
              <button
                type="button"
                onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}
                className="mt-2 text-xs text-muted hover:text-ink"
              >
                {useRecovery ? 'Ввести код из приложения' : 'Использовать код восстановления'}
              </button>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 flex items-center justify-center gap-2 bg-brand disabled:opacity-50 text-on-accent font-bold text-sm py-2.5 rounded-lg transition btn-press"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <span>Войти в панель</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <p className="text-xs text-faint text-center mt-6">
          Dementia Panel &bull; Изолированное управление AmneziaWG
        </p>
      </div>
    </div>
  );
};
