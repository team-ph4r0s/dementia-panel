import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { NodeUpdateSettings, NodeUpdatesOverview } from '../types';
import { useFeedback } from './ui/feedback-context';

export function NodeUpdatesCard({ onChanged }: { onChanged: () => void }) {
  const [overview, setOverview] = useState<NodeUpdatesOverview | null>(null);
  const [settings, setSettings] = useState<NodeUpdateSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { confirm, toast } = useFeedback();
  const load = useCallback(async () => {
    try {
      const value = await api.getNodeUpdates();
      setOverview(value);
      setSettings((s) => s ?? value.settings);
      setError('');
    } catch (err: any) { setError(err.message); }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const start = async (mode: 'check' | 'update') => {
    if (mode === 'update' && !(await confirm({
      title: 'Обновить AmneziaWG на всех нодах?',
      message: 'Ноды с доступным обновлением будут обновляться по одной. VPN кратковременно прервётся; ключи и клиенты сохранятся. При ошибке запуска будет выполнен откат.',
      confirmLabel: 'Обновить все',
    }))) return;
    setBusy(true);
    try { await api.startNodeUpdates(mode); await load(); onChanged(); }
    catch (err: any) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!settings) return;
    setBusy(true);
    try { setSettings(await api.saveNodeUpdateSettings(settings)); toast('Расписание сохранено', 'success'); }
    catch (err: any) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  };
  const button = 'px-3 py-2 rounded-lg border border-line bg-soft text-ink text-xs btn-press disabled:opacity-50';
  const available = overview?.nodes.filter((n) => n.available).length ?? 0;
  return <section className="bg-card border border-line rounded-2xl p-4 space-y-3" aria-label="Обновления AmneziaWG">
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="font-semibold text-sm text-ink">Обновления AmneziaWG</h3>
      <span className="text-xs text-muted">{overview?.running ? 'Выполняется обслуживание нод…' : `Доступно обновлений: ${available}`}</span>
      <button className={button} disabled={busy || overview?.running || !overview} onClick={() => start('check')}>Проверить образы</button>
      <button className={button} disabled={busy || overview?.running || !available} onClick={() => start('update')}>Обновить все</button>
    </div>
    <p className="text-xs text-muted">Проверка раз в сутки. Обновляются только контейнеры панели; клиенты, ключи и параметры сохраняются. Во время замены VPN кратковременно недоступен.</p>
    {settings && <div className="flex flex-wrap items-center gap-3 text-xs text-ink">
      <label className="flex items-center gap-2"><input type="checkbox" checked={settings.auto_update} onChange={(e) => setSettings({ ...settings, auto_update: e.target.checked })} />Автообновление</label>
      <label className="flex items-center gap-2">Час UTC
        <select aria-label="Час автообновления UTC" className="bg-soft border border-line rounded-lg px-2 py-1.5" value={settings.hour_utc} onChange={(e) => setSettings({ ...settings, hour_utc: Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00–{String((h + 1) % 24).padStart(2, '0')}:00</option>)}
        </select>
      </label>
      <button className={button} disabled={busy} onClick={save}>Сохранить расписание</button>
    </div>}
    {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    {overview?.nodes.filter((n) => n.available || n.error || n.updated_at).map((n) => <p key={n.server_id} className={`text-xs ${n.error ? 'text-bad' : n.available ? 'text-warn' : 'text-muted'}`}>
      {n.name}: {n.error || (n.available ? 'доступно обновление' : `обновлено ${new Date(n.updated_at!).toLocaleString('ru-RU')}`)}
    </p>)}
  </section>;
}
