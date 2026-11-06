import { useState, type FormEvent } from 'react';
import { Shuffle, X } from 'lucide-react';
import { api } from '../api';
import type { Server } from '../types';
import { useFeedback } from './ui/feedback-context';
import { ModalShell } from './ui/Modal';

interface VlessParamsModalProps {
  server: Server;
  onClose: () => void;
  onUpdated: (server: Server) => void;
}

const title = 'Параметры Reality';
const warning = 'После изменения параметров пользователям нужно обновить подписку или заново импортировать ссылку VLESS.';
const fingerprints = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'];
const inputClass = 'mt-1 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm font-mono text-ink focus:border-brand';

function toForm(server: Server) {
  return {
    sni: server.reality_sni ?? '',
    dest: server.reality_dest ?? '',
    shortIds: server.reality_short_ids?.join(', ') ?? '',
    flow: server.xray_flow ?? 'xtls-rprx-vision',
    fingerprint: server.xray_fingerprint ?? 'chrome',
  };
}

export function VlessParamsModal({ server, onClose, onUpdated }: VlessParamsModalProps) {
  const { confirm, toast } = useFeedback();
  const [form, setForm] = useState(() => toForm(server));
  const [busy, setBusy] = useState(false);

  const update = async (request: () => Promise<Server>, randomize = false) => {
    setBusy(true);
    try {
      if (server.status !== 'uninstalled' && !(await confirm({
        title: randomize ? 'Сгенерировать параметры Reality?' : 'Сохранить параметры Reality?',
        message: warning,
      }))) return;
      const updated = await request();
      onUpdated(updated);
      if (randomize) setForm(toForm(updated));
      else onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось изменить параметры Reality', 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void update(() => api.updateServer(server.id, {
      reality_sni: form.sni.trim(),
      reality_dest: form.dest.trim(),
      reality_short_ids: form.shortIds.split(',').map((id) => id.trim().toLowerCase()),
      xray_flow: form.flow,
      xray_fingerprint: form.fingerprint,
    }));
  };

  return (
    <ModalShell label={title} onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-lg shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-line">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            <p className="text-xs text-muted break-all">{server.name} ({server.host})</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="p-1 text-muted hover:text-ink rounded-lg hover:bg-soft border border-line">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={save} className="p-6 overflow-y-auto">
          <fieldset disabled={busy} className="space-y-4 min-w-0 disabled:opacity-50">
            <p className="p-3 bg-warn-soft text-warn rounded-lg text-xs">{warning}</p>
            <label className="block text-xs text-muted">
              SNI
              <input required value={form.sni} onChange={(e) => setForm({ ...form, sni: e.target.value })} className={inputClass} />
            </label>
            <label className="block text-xs text-muted">
              Адрес маскировки (домен:порт)
              <input required value={form.dest} onChange={(e) => setForm({ ...form, dest: e.target.value })} className={inputClass} />
            </label>
            <label className="block text-xs text-muted">
              shortId (через запятую)
              <input value={form.shortIds} onChange={(e) => setForm({ ...form, shortIds: e.target.value })} className={inputClass} aria-describedby="reality-short-id-hint" />
            </label>
            <p id="reality-short-id-hint" className="text-xs text-muted">
              От 1 до 8 значений, до 16 шестнадцатеричных символов чётной длины. Пустое значение тоже допустимо. Клиенты получают первый shortId.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                Flow
                <select value={form.flow} onChange={(e) => setForm({ ...form, flow: e.target.value === '' ? '' : 'xtls-rprx-vision' })} className={inputClass}>
                  <option value="xtls-rprx-vision">xtls-rprx-vision</option>
                  <option value="">Без flow</option>
                </select>
              </label>
              <label className="text-xs text-muted">
                Отпечаток TLS
                <select value={form.fingerprint} onChange={(e) => setForm({ ...form, fingerprint: e.target.value })} className={inputClass}>
                  {fingerprints.map((fingerprint) => <option key={fingerprint}>{fingerprint}</option>)}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-line">
              <button
                type="button"
                onClick={() => void update(() => api.randomizeParams(server.id), true)}
                className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-ink bg-soft hover:bg-soft-2 rounded-lg btn-press border border-line"
              >
                <Shuffle className="w-3.5 h-3.5 text-brand" />
                Сгенерировать новые
              </button>
              <button type="submit" className="bg-brand text-on-accent font-bold text-sm px-4 py-2 rounded-lg btn-press">
                Сохранить
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </ModalShell>
  );
}
