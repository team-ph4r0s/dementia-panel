import React, { useState } from 'react';
import { X, Dna, Shuffle, Save, Info, KeyRound, ArrowUpCircle } from 'lucide-react';
import { api } from '../api';
import type { Server, ServerUpdate } from '../types';
import { useFeedback } from './ui/feedback-context';
import { ModalShell } from './ui/Modal';

interface AwgParamsModalProps {
  isOpen: boolean;
  server: Server | null;
  onClose: () => void;
  onUpdated: (server: Server) => void;
}

// Хуки живут во внутреннем компоненте: он монтируется только при открытии окна,
// а key пересоздаёт его при выборе другого сервера
export const AwgParamsModal: React.FC<AwgParamsModalProps> = ({ isOpen, server, onClose, onUpdated }) => {
  if (!isOpen || !server) return null;
  return <AwgParamsForm key={server.id} server={server} onClose={onClose} onUpdated={onUpdated} />;
};

const CHANGE_WARNING =
  'Сервер AmneziaWG будет перезапущен с новыми параметрами. Все текущие подключения оборвутся, ' +
  'а клиентам нужно будет обновить подписку или заново импортировать конфигурацию. Продолжить?';

const CLIENT_ONLY_KEYS: readonly string[] = ['i1', 'i2', 'i3', 'i4', 'i5'];

const PRESETS: { id: 'quic' | 'dns' | 'stun'; label: string; hint: string }[] = [
  { id: 'quic', label: 'QUIC', hint: 'Пакет QUIC Initial (HTTP/3) с именем домена в ClientHello' },
  { id: 'dns', label: 'DNS', hint: 'DNS-запрос адреса домена' },
  { id: 'stun', label: 'STUN', hint: 'STUN Binding Request, как у звонков WebRTC (домен не нужен)' },
];

const inputBase =
  'w-full bg-paper border border-line rounded-xl px-3 py-1.5 text-ink text-sm focus:outline-none font-mono';

type FormState = {
  jc: string;
  jmin: string;
  jmax: string;
  s1: string;
  s2: string;
  s3: string;
  s4: string;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  i1: string;
  i2: string;
  i3: string;
  i4: string;
  i5: string;
  header_protection_key: string;
};

function toForm(server: Server): FormState {
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return {
    jc: str(server.jc),
    jmin: str(server.jmin),
    jmax: str(server.jmax),
    s1: str(server.s1),
    s2: str(server.s2),
    s3: str(server.s3),
    s4: str(server.s4),
    h1: str(server.h1),
    h2: str(server.h2),
    h3: str(server.h3),
    h4: str(server.h4),
    i1: str(server.i1),
    i2: str(server.i2),
    i3: str(server.i3),
    i4: str(server.i4),
    i5: str(server.i5),
    header_protection_key: str(server.header_protection_key),
  };
}

function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

const Field: React.FC<{
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  accent: string;
  numeric?: boolean;
}> = ({ label, hint, value, onChange, accent, numeric }) => (
  <div>
    <label className="block text-xs font-medium text-muted mb-1" title={hint}>
      {label}
    </label>
    <input
      type={numeric ? 'number' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputBase} ${accent}`}
    />
  </div>
);

const AwgParamsForm: React.FC<{ server: Server; onClose: () => void; onUpdated: (server: Server) => void }> = ({
  server,
  onClose,
  onUpdated,
}) => {
  const { toast, confirm } = useFeedback();
  const installed = server.status !== 'uninstalled';
  const modern = server.awg_version >= 3;
  const outdated = server.awg_version < server.latest_awg_version;
  const [form, setForm] = useState<FormState>(() => toForm(server));
  const [loading, setLoading] = useState(false);
  const [presetDomain, setPresetDomain] = useState('');

  const set = (key: keyof FormState) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleRandomize = async () => {
    if (installed && !(await confirm(CHANGE_WARNING))) return;
    try {
      setLoading(true);
      const updated = await api.randomizeParams(server.id);
      setForm(toForm(updated));
      onUpdated(updated);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleUpgrade = async () => {
    const message =
      `Перевести сервер на AmneziaWG ${server.latest_awg_version}.x?\n\n` +
      'Будут сгенерированы параметры актуальной версии (S3, S4, диапазоны H1–H4, защита заголовков), ' +
      (installed ? 'а AmneziaWG переустановлен с последним образом. ' : '') +
      'Все клиенты должны обновить подписку или конфигурацию, приложения должны поддерживать AmneziaWG 3.x.';
    if (!(await confirm(message))) return;
    try {
      setLoading(true);
      const res = await api.upgradeProtocol(server.id);
      onUpdated(res.server);
      if (!res.success) toast(`Переустановка не удалась: ${res.error}`, 'error');
      onClose();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handlePreset = async (preset: 'quic' | 'dns' | 'stun') => {
    if (preset !== 'stun' && !presetDomain.trim()) {
      toast('Укажите домен, под обращение к которому маскируется пакет', 'error');
      return;
    }
    try {
      setLoading(true);
      const { i1 } = await api.awgSignature(preset, presetDomain.trim());
      set('i1')(i1);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    // I1–I5 есть только в конфигурации клиента: если изменились лишь они, нода не перезапускается
    const initial = toForm(server);
    const restart = installed && (Object.keys(form) as (keyof FormState)[]).some(
      (key) => !CLIENT_ONLY_KEYS.includes(key) && form[key].trim() !== initial[key]
    );
    if (restart && !(await confirm(CHANGE_WARNING))) return;
    const update: ServerUpdate = {
      jc: Number(form.jc),
      jmin: Number(form.jmin),
      jmax: Number(form.jmax),
      s1: Number(form.s1),
      s2: Number(form.s2),
      h1: form.h1.trim(),
      h2: form.h2.trim(),
      h3: form.h3.trim(),
      h4: form.h4.trim(),
      i1: form.i1.trim() || null,
      i2: form.i2.trim() || null,
      i3: form.i3.trim() || null,
      i4: form.i4.trim() || null,
      i5: form.i5.trim() || null,
    };
    if (modern) {
      update.s3 = Number(form.s3);
      update.s4 = Number(form.s4);
      update.header_protection_key = form.header_protection_key.trim() || null;
    }
    try {
      setLoading(true);
      const updated = await api.updateServer(server.id, update);
      onUpdated(updated);
      if (installed && !restart) toast('Сохранено. Нода не перезапускалась; клиентам нужно обновить подписку или конфигурацию');
      onClose();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const extras = Object.entries(server.extra_params || {});

  return (
    <ModalShell label="Параметры AmneziaWG" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-2xl shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-card">
          <div className="flex items-center gap-2">
            <Dna className="w-5 h-5 text-ok" />
            <div>
              <h2 className="text-base font-semibold text-ink">
                Параметры обфускации AmneziaWG {modern ? '3.x' : '1.x'}
              </h2>
              <p className="text-xs text-muted">{server.name} ({server.host})</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Закрыть" className="text-muted hover:text-ink transition p-1 rounded-lg hover:bg-soft border border-line">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="p-6 space-y-5 overflow-y-auto">
          {outdated && (
            <div className="p-3 bg-warn-soft border border-line rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-warn">
              <span>
                Сервер использует устаревший формат AmneziaWG 1.x (одиночные H, без S3/S4 и защиты заголовков).
              </span>
              <button
                type="button"
                onClick={handleUpgrade}
                disabled={loading}
                className="flex items-center gap-1.5 bg-warn-soft hover:bg-warn-soft font-medium px-3 py-1.5 rounded-lg transition"
              >
                <ArrowUpCircle className="w-3.5 h-3.5" />
                <span>Перейти на {server.latest_awg_version}.x</span>
              </button>
            </div>
          )}

          <div className="p-3 bg-paper border border-line rounded-xl flex items-start gap-3 text-xs text-muted">
            <Info className="w-4 h-4 text-ok flex-shrink-0 mt-0.5" />
            <span>
              S1–S4, H1–H4 и ключ защиты заголовков должны совпадать на сервере и клиентах; Jc/Jmin/Jmax и I1–I5 — только у клиента.
              {installed && ' После сохранения AmneziaWG на сервере будет перезапущен, а клиентам потребуется обновить конфигурацию.'}
            </span>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ok">Мусорные пакеты</h3>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Jc (кол-во)" value={form.jc} onChange={set('jc')} accent="focus:border-brand" numeric />
              <Field label="Jmin (байт)" value={form.jmin} onChange={set('jmin')} accent="focus:border-brand" numeric />
              <Field label="Jmax (байт)" value={form.jmax} onChange={set('jmax')} accent="focus:border-brand" numeric />
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-info">Дополнение пакетов (padding)</h3>
            <div className={`grid gap-3 ${modern ? 'grid-cols-4' : 'grid-cols-2'}`}>
              <Field label="S1 (init)" value={form.s1} onChange={set('s1')} accent="focus:border-brand" numeric />
              <Field label="S2 (response)" value={form.s2} onChange={set('s2')} accent="focus:border-brand" numeric />
              {modern && <Field label="S3 (cookie)" value={form.s3} onChange={set('s3')} accent="focus:border-brand" numeric />}
              {modern && <Field label="S4 (transport, ≤32)" value={form.s4} onChange={set('s4')} accent="focus:border-brand" numeric />}
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-accent">
              Заголовки {modern ? '(диапазоны без пересечений, например 100000-200000)' : ''}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="H1 (initiation)" value={form.h1} onChange={set('h1')} accent="focus:border-brand" />
              <Field label="H2 (response)" value={form.h2} onChange={set('h2')} accent="focus:border-brand" />
              <Field label="H3 (cookie reply)" value={form.h3} onChange={set('h3')} accent="focus:border-brand" />
              <Field label="H4 (transport)" value={form.h4} onChange={set('h4')} accent="focus:border-brand" />
            </div>
          </div>

          {modern && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-warn">Защита заголовков</h3>
              <div className="flex items-center gap-2">
                <input
                  value={form.header_protection_key}
                  onChange={(e) => set('header_protection_key')(e.target.value)}
                  placeholder="выключена"
                  className={`${inputBase} focus:border-brand text-xs`}
                />
                <button
                  type="button"
                  onClick={() => set('header_protection_key')(generateKey())}
                  className="flex items-center gap-1.5 flex-shrink-0 px-3 py-1.5 text-xs bg-soft hover:bg-soft-2 text-ink rounded-xl transition border border-line"
                  title="Сгенерировать новый ключ"
                >
                  <KeyRound className="w-3.5 h-3.5 text-warn" />
                  <span>Новый</span>
                </button>
              </div>
              <p className="text-xs text-faint">HeaderProtectionKey шифрует заголовки пакетов. Требует S1–S4 не меньше 12.</p>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink">Сигнатурные пакеты I1–I5 (необязательно)</h3>
            <p className="text-xs text-faint">
              Отправляются клиентом перед рукопожатием. Теги: <code>&lt;b 0x…&gt;</code>, <code>&lt;r N&gt;</code>, <code>&lt;rd N&gt;</code>,{' '}
              <code>&lt;rc N&gt;</code>, <code>&lt;t&gt;</code>. Есть только в конфигурации клиента: их смена не перезапускает ноду.
            </p>
            <p className="text-xs text-faint">
              Обычно достаточно одного I1: нажмите готовый пресет ниже. I2–I5 — необязательные дополнительные пакеты, которые клиент отправляет
              следом за I1; пресетов для них нет, поэтому панель их сама не заполняет. Пустые поля — это нормально. Заполняйте I2–I5 только
              если знаете, зачем, и начинайте с I1: цепочка идёт по порядку. Нужны приложения с поддержкой I (AmneziaWG 1.5+/2.0), после
              сохранения клиентам надо обновить подписку или конфиг.
            </p>
            <div className="p-3 bg-paper border border-line rounded-xl space-y-2">
              <p className="text-xs text-muted">
                Готовый I1: начало соединения выглядит для фильтров как известный протокол. Домен — чужой популярный сайт, обращение к
                которому обычно в сети пользователей (для QUIC — с поддержкой HTTP/3), не адрес вашей панели или ноды. STUN домен не требует.
                Каждое нажатие создаёт новый пакет и заменяет только поле I1.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={presetDomain}
                  onChange={(e) => setPresetDomain(e.target.value)}
                  placeholder="example.com"
                  aria-label="Домен для пресета"
                  className={`${inputBase} focus:border-brand text-xs flex-1 min-w-40`}
                />
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handlePreset(preset.id)}
                    disabled={loading}
                    title={preset.hint}
                    className="px-3 py-1.5 text-xs font-mono bg-soft hover:bg-soft-2 text-ink rounded-lg transition border border-line btn-press disabled:opacity-50"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            {(['i1', 'i2', 'i3', 'i4', 'i5'] as const).map((key) => (
              <input
                key={key}
                value={form[key]}
                onChange={(e) => set(key)(e.target.value)}
                placeholder={key.toUpperCase()}
                className={`${inputBase} focus:border-brand text-xs`}
              />
            ))}
          </div>

          {extras.length > 0 && (
            <div className="text-xs text-faint space-y-1">
              <p className="font-medium text-muted">Дополнительные параметры (импортированы, сохраняются как есть):</p>
              {extras.map(([key, value]) => (
                <p key={key} className="font-mono">
                  {key} = {value}
                </p>
              ))}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-4 border-t border-line">
            <button
              type="button"
              onClick={handleRandomize}
              disabled={loading}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-ink hover:text-ink bg-soft hover:bg-soft-2 rounded-xl transition border border-line"
            >
              <Shuffle className="w-3.5 h-3.5 text-ok" />
              <span>Случайные параметры</span>
            </button>

            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-ink transition">
                Отмена
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2 rounded-lg transition btn-press hover:text-on-accent"
              >
                <Save className="w-4 h-4" />
                <span>Сохранить</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </ModalShell>
  );
};
