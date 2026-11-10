import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, CreditCard, ExternalLink, Eye, EyeOff, Loader2, RefreshCw, Save } from 'lucide-react';
import { api } from '../api';
import type { ProviderCurrency, ProviderInput, ProviderItem, ProviderSettings, ProvidersData } from '../types';
import { useFeedback } from './ui/feedback-context';

const CURRENCIES: { id: ProviderCurrency; label: string }[] = [
  { id: 'RUB', label: '₽ RUB' },
  { id: 'USD', label: '$ USD' },
  { id: 'EUR', label: '€ EUR' },
];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const REMIND_OPTIONS = [0, 1, 2, 3, 5, 7, 14];
const TYPE_LABEL = { panel: 'Панель', node: 'Нода', bridge: 'Мост' } as const;

const inputClass = 'w-full bg-paper border border-line rounded-xl px-3 py-2 text-sm text-ink';

const keyOf = (item: ProviderItem) => `${item.target_type}:${item.target_id}`;

function toDraft(item: ProviderItem): ProviderInput {
  return {
    url: item.url ?? '',
    login: item.login ?? '',
    amount: item.amount === null ? '' : String(item.amount),
    currency: item.currency,
    pay_day: item.pay_day === null ? '' : String(item.pay_day),
    pay_month: item.pay_month === null ? '' : String(item.pay_month),
  };
}

/** «через 3 дня», «завтра», «сегодня» */
function dueLabel(item: Pick<ProviderItem, 'next_due' | 'days_left'>): string | null {
  if (item.next_due === null || item.days_left === null) return null;
  const [, m, d] = item.next_due.split('-').map(Number);
  const date = `${d} ${MONTHS[m - 1]}`;
  if (item.days_left === 0) return `сегодня, ${date}`;
  if (item.days_left === 1) return `завтра, ${date}`;
  return `${date} (через ${item.days_left} дн.)`;
}

const ProviderCard: React.FC<{ item: ProviderItem; onSaved: (items: ProviderItem[]) => void }> = ({ item, onSaved }) => {
  const { toast } = useFeedback();
  const [draft, setDraft] = useState<ProviderInput>(() => toDraft(item));
  const [password, setPassword] = useState<string | null>(null); // null — не менялся
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = `${item.target_type}-${item.target_id}`;

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(item)) || password !== null;
  const set = (patch: Partial<ProviderInput>) => setDraft((d) => ({ ...d, ...patch }));
  const due = dueLabel(item);
  const soon = item.days_left !== null && item.days_left <= 3;

  const toggleShow = async () => {
    if (shown) { setShown(false); return; }
    if (password === null && item.password_saved) {
      try { setPassword(await api.getProviderPassword(item.target_type, item.target_id)); }
      catch (err) { toast(err instanceof Error ? err.message : 'Не удалось получить пароль', 'error'); return; }
    }
    setShown(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      const items = await api.saveProvider(item.target_type, item.target_id, { ...draft, ...(password !== null ? { password } : {}) });
      onSaved(items);
      setPassword(null);
      setShown(false);
      toast('Данные провайдера сохранены', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось сохранить', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="bg-card border border-line rounded-2xl p-4 sm:p-5 space-y-4" aria-label={item.name}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display text-base font-bold text-ink break-words">{item.name}</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-paper border border-line text-muted">{TYPE_LABEL[item.target_type]}</span>
          </div>
          {item.host && <div className="text-xs font-mono text-faint mt-1 break-all">{item.host}</div>}
        </div>
        {due && (
          <span className={`text-xs px-2.5 py-1 rounded-full ${soon ? 'bg-warn-soft text-warn' : 'bg-info-soft text-info'}`}>
            Платёж: {due}
          </span>
        )}
      </header>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label htmlFor={`${id}-url`} className="block text-xs text-muted mb-1">Личный кабинет</label>
          <div className="flex gap-2">
            <input id={`${id}-url`} value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://…" inputMode="url" autoComplete="off" className={`${inputClass} font-mono`} />
            {item.url && (
              <a href={item.url} target="_blank" rel="noopener noreferrer" title="Открыть кабинет" aria-label="Открыть кабинет"
                className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg bg-paper border border-line text-muted hover:text-ink btn-press">
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-login`} className="block text-xs text-muted mb-1">Логин</label>
            <input id={`${id}-login`} value={draft.login} onChange={(e) => set({ login: e.target.value })} autoComplete="off" className={`${inputClass} font-mono`} />
          </div>
          <div>
            <label htmlFor={`${id}-password`} className="block text-xs text-muted mb-1">Пароль</label>
            <div className="flex gap-2">
              <input
                id={`${id}-password`}
                type={shown ? 'text' : 'password'}
                autoComplete="new-password"
                value={password ?? ''}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={item.password_saved ? '••••••••' : ''}
                className={`${inputClass} font-mono min-w-0`}
              />
              {(item.password_saved || password) && (
                <button type="button" onClick={() => void toggleShow()} title={shown ? 'Скрыть пароль' : 'Показать пароль'} aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'}
                  className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg bg-paper border border-line text-muted hover:text-ink btn-press">
                  {shown ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label htmlFor={`${id}-amount`} className="block text-xs text-muted mb-1">Сумма в месяц</label>
          <input id={`${id}-amount`} value={draft.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" placeholder="500" className={`${inputClass} font-mono`} />
        </div>
        <div>
          <label htmlFor={`${id}-currency`} className="block text-xs text-muted mb-1">Валюта</label>
          <select id={`${id}-currency`} value={draft.currency} onChange={(e) => set({ currency: e.target.value as ProviderCurrency })} className={inputClass}>
            {CURRENCIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-day`} className="block text-xs text-muted mb-1">Дата платежа: день</label>
          <input id={`${id}-day`} value={draft.pay_day} onChange={(e) => set({ pay_day: e.target.value.replace(/\D/g, '').slice(0, 2) })} inputMode="numeric" placeholder="15" className={`${inputClass} font-mono`} />
        </div>
        <div>
          <label htmlFor={`${id}-month`} className="block text-xs text-muted mb-1">месяц</label>
          <select id={`${id}-month`} value={draft.pay_month} onChange={(e) => set({ pay_month: e.target.value })} className={inputClass}>
            <option value="">каждый месяц</option>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m} (раз в год)</option>)}
          </select>
        </div>
      </div>

      <div className="flex justify-end">
        <button type="button" disabled={!dirty || busy} onClick={() => void save()}
          className="inline-flex items-center gap-2 px-4 h-10 rounded-lg bg-brand text-on-accent text-sm font-medium btn-press disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Сохранить
        </button>
      </div>
    </article>
  );
};

const RemindersCard: React.FC<{ settings: ProviderSettings; telegramReady: boolean; onSaved: (s: ProviderSettings) => void }> = ({ settings, telegramReady, onSaved }) => {
  const { toast } = useFeedback();
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  const options = [...new Set([...REMIND_OPTIONS, ...settings.remind_days])].sort((a, b) => a - b);
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const localHour = (utcHour: number) => {
    const d = new Date(Date.UTC(2026, 0, 1, utcHour));
    return `${String(d.getHours()).padStart(2, '0')}:00`;
  };

  const toggleDay = (day: number) => setForm((f) => ({
    ...f,
    remind_days: f.remind_days.includes(day) ? f.remind_days.filter((d) => d !== day) : [...f.remind_days, day].sort((a, b) => b - a),
  }));

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.saveProviderSettings(form);
      setForm(saved);
      onSaved(saved);
      toast('Напоминания сохранены', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось сохранить', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-card border border-line rounded-2xl p-4 sm:p-5 space-y-4">
      <div className="flex items-center gap-2">
        <BellRing className="w-5 h-5 text-info" />
        <h3 className="text-base font-semibold text-ink">Напоминания об оплате в Telegram</h3>
      </div>
      {!telegramReady && (
        <div className="p-3 rounded-xl border border-line bg-warn-soft text-warn text-xs">
          Telegram не настроен или выключен, напоминания не уйдут. Бот и ID чата задаются в разделе «Безопасность», карточка «Уведомления в Telegram».
        </div>
      )}
      <label className="flex items-center gap-3 text-sm text-ink cursor-pointer">
        <input type="checkbox" checked={form.remind_enabled} onChange={(e) => setForm({ ...form, remind_enabled: e.target.checked })} />
        Напоминать о платежах
      </label>
      <fieldset className="space-y-2">
        <legend className="text-xs text-muted">Когда напоминать</legend>
        <div className="flex flex-wrap gap-2">
          {options.map((day) => (
            <label key={day} className={`px-3 h-10 inline-flex items-center gap-2 rounded-lg border text-sm cursor-pointer btn-press ${form.remind_days.includes(day) ? 'border-brand bg-brand-soft text-ink' : 'border-line bg-paper text-muted'}`}>
              <input type="checkbox" className="sr-only" checked={form.remind_days.includes(day)} onChange={() => toggleDay(day)} />
              {day === 0 ? 'В день платежа' : day === 1 ? 'За 1 день' : `За ${day} дн.`}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="max-w-xs">
        <label htmlFor="providers-hour" className="block text-xs text-muted mb-1">Во сколько присылать</label>
        <select id="providers-hour" value={form.remind_hour} onChange={(e) => setForm({ ...form, remind_hour: Number(e.target.value) })} className={inputClass}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00 UTC (у вас {localHour(h)})</option>)}
        </select>
      </div>
      <div className="flex justify-end">
        <button type="button" disabled={!dirty || busy || form.remind_days.length === 0} onClick={() => void save()}
          className="inline-flex items-center gap-2 px-4 h-10 rounded-lg bg-brand text-on-accent text-sm font-medium btn-press disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Сохранить
        </button>
      </div>
    </section>
  );
};

export const ProvidersView: React.FC = () => {
  const [data, setData] = useState<ProvidersData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.getProviders());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки провайдеров');
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-ink flex items-center gap-2"><CreditCard className="w-5 h-5 text-brand" />Провайдеры</h2>
          <p className="text-sm text-muted mt-1">Личные кабинеты, суммы и даты платежей за панель, ноды и мосты. Пароли хранятся зашифрованными.</p>
        </div>
        <button type="button" onClick={() => void load()} className="p-2 rounded-full bg-paper text-muted hover:text-ink" title="Обновить" aria-label="Обновить"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {error && <div className="p-3 rounded-xl border border-line bg-bad-soft text-bad text-sm">{error}</div>}
      {!data && !error && <div className="text-sm text-faint py-12 text-center">Загрузка...</div>}

      {data && (
        <>
          <RemindersCard settings={data.settings} telegramReady={data.telegram_ready} onSaved={(settings) => setData({ ...data, settings })} />
          <div className="grid gap-4 xl:grid-cols-2">
            {data.items.map((item) => (
              <ProviderCard key={`${keyOf(item)}:${item.url}:${item.login}:${item.amount}:${item.currency}:${item.pay_day}:${item.pay_month}:${item.password_saved}`}
                item={item} onSaved={(items) => setData({ ...data, items })} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};
