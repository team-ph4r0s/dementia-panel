import React, { useEffect, useState } from 'react';
import { Settings2, Save, Loader2 } from 'lucide-react';
import type { PanelSettings } from '../types';
import { api } from '../api';

const inputClass =
  'w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm';

export const PanelSettingsCard: React.FC<{ onSaved?: (settings: PanelSettings) => void }> = ({ onSaved }) => {
  const [form, setForm] = useState<PanelSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api.getSettings().then(setForm).catch((err) => setMessage({ type: 'error', text: err.message }));
  }, []);

  if (!form) return null;

  const update = <K extends keyof PanelSettings>(key: K, value: PanelSettings[K]) => setForm({ ...form, [key]: value });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api.updateSettings({ ...form, client_mtu: Number(form.client_mtu) });
      setForm(saved);
      onSaved?.(saved);
      setMessage({
        type: 'success',
        text: 'Настройки сохранены. DNS и MTU применятся к новым конфигам и при следующем обновлении подписок.',
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
        <Settings2 className="w-5 h-5 text-ok" />
        <h3 className="text-base font-semibold text-ink">Настройки панели</h3>
      </div>

      {message && (
        <div
          className={`p-3 rounded-xl border text-xs ${
            message.type === 'success'
              ? 'bg-ok-soft border-line text-ok'
              : 'bg-bad-soft border-line text-bad'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-muted mb-1">Публичный адрес панели (для ссылок подписок)</label>
          <input
            type="url"
            placeholder={window.location.origin}
            value={form.public_url}
            onChange={(e) => update('public_url', e.target.value)}
            className={inputClass}
          />
          <p className="text-xs text-faint mt-1">
            Укажите, если панель открыта через SSH-туннель, localhost или внутренний адрес — иначе пользователи получат нерабочую ссылку.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted mb-1">DNS для клиентов</label>
          <input value={form.client_dns} onChange={(e) => update('client_dns', e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted mb-1">MTU клиентов</label>
          <input
            type="number"
            min={576}
            max={1500}
            value={form.client_mtu}
            onChange={(e) => update('client_mtu', Number(e.target.value))}
            className={inputClass}
          />
        </div>

      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2 rounded-lg transition btn-press hover:text-on-accent"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>Сохранить</span>
        </button>
      </div>
    </form>
  );
};
