import React, { useEffect, useState } from 'react';
import { Eye, Loader2, Save, Dices } from 'lucide-react';
import type { GuestAccess } from '../types';
import { api } from '../api';

const inputClass =
  'w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Случайный пароль из символов, которые не путаются при вводе */
function generatePassword(length = 14): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length]).join('');
}

/**
 * Гостевой доступ: отдельные логин и пароль, с которыми человек видит панель изнутри, но ничего не меняет
 */
export const GuestAccessCard: React.FC = () => {
  const [saved, setSaved] = useState<GuestAccess | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  /** Пароль показывается, пока его только что задали: потом сервер его не отдаёт */
  const [shownPassword, setShownPassword] = useState('');

  const apply = (data: GuestAccess) => {
    setSaved(data);
    setEnabled(data.enabled);
    setUsername(data.username);
  };

  useEffect(() => {
    api.getGuestAccess().then(apply).catch((err) => setMessage({ type: 'error', text: err.message }));
  }, []);

  if (!saved) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const data = await api.saveGuestAccess({
        enabled,
        username: username.trim(),
        password: password || undefined,
        current_password: adminPassword,
      });
      apply(data);
      setShownPassword(password);
      setPassword('');
      setAdminPassword('');
      setMessage({
        type: 'success',
        text: data.enabled
          ? 'Сохранено. Действующие гостевые сессии завершены — гости входят заново с этими данными.'
          : 'Гостевой доступ отключён, гостевые сессии завершены.',
      });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="bg-card border border-line rounded-2xl p-6 shadow-pop space-y-4">
      <div className="flex items-center gap-2">
        <Eye className="w-5 h-5 text-info" />
        <h3 className="text-base font-semibold text-ink">Гостевой доступ</h3>
        {saved.enabled && <span className="text-xs px-2 py-0.5 rounded-full bg-ok-soft text-ok">включён</span>}
      </div>
      <p className="text-xs text-muted">
        Отдельные логин и пароль для постороннего человека: он видит панель изнутри, но ничего не может изменить. Ссылки подписок,
        ключи, конфиги, QR-коды, SSH-доступы, резервные копии и настройки безопасности ему недоступны. Гостевая сессия действует 24 часа.
      </p>

      {message && (
        <div className={`p-3 rounded-xl border text-xs ${message.type === 'success' ? 'bg-ok-soft border-line text-ok' : 'bg-bad-soft border-line text-bad'}`}>
          {message.text}
        </div>
      )}
      {shownPassword && message?.type === 'success' && enabled && (
        <div className="p-3 bg-paper border border-line rounded-xl text-xs text-muted">
          Данные для гостя: логин <code className="text-ink">{saved.username}</code>, пароль <code className="text-ink select-all">{shownPassword}</code>.
          Пароль больше показан не будет.
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Разрешить вход гостю
      </label>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-muted mb-1" htmlFor="guest-username">Логин гостя</label>
          <input id="guest-username" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64} autoComplete="off" placeholder="guest" className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted mb-1" htmlFor="guest-password">
            Пароль гостя{saved.has_password ? ' (оставьте пустым, чтобы не менять)' : ''}
          </label>
          <div className="flex gap-2">
            <input
              id="guest-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={saved.has_password ? '••••••••' : 'не короче 8 символов'}
              className={`${inputClass} font-mono`}
            />
            <button
              type="button"
              onClick={() => setPassword(generatePassword())}
              title="Сгенерировать пароль"
              aria-label="Сгенерировать пароль"
              className="px-3 rounded-xl bg-soft text-ink hover:bg-soft-2 border border-line"
            >
              <Dices className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-muted mb-1" htmlFor="guest-admin-password">Ваш пароль администратора (подтверждение)</label>
          <input id="guest-admin-password" type="password" required value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} autoComplete="current-password" className={inputClass} />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2 rounded-lg transition btn-press"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>Сохранить</span>
        </button>
      </div>
    </form>
  );
};
