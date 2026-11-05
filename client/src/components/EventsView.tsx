import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Info, RefreshCw, XCircle } from 'lucide-react';
import { api } from '../api';
import type { EventLevel, EventsPage } from '../types';

const labels: Record<EventLevel, string> = { info: 'Информация', warning: 'Предупреждение', error: 'Ошибка' };
const icons = { info: Info, warning: AlertTriangle, error: XCircle };
const colors = { info: 'text-info bg-info-soft', warning: 'text-warn bg-warn-soft', error: 'text-bad bg-bad-soft' };

export const EventsView: React.FC = () => {
  const [level, setLevel] = useState<EventLevel | ''>('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<EventsPage>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await api.getEvents({ level: level || undefined, limit, offset }));
    } finally {
      setLoading(false);
    }
  }, [level, offset]);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  return (
    <section data-guest-ok className="bg-card border border-line rounded-2xl p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-ink">Журнал событий</h2>
          <p className="text-sm text-muted mt-1">Последние 5000 событий панели</p>
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="Уровень событий" value={level} onChange={(e) => { setLevel(e.target.value as EventLevel | ''); setOffset(0); }} className="bg-paper border border-line rounded-xl px-3 py-2 text-sm text-ink">
            <option value="">Все уровни</option>
            <option value="info">Информация</option>
            <option value="warning">Предупреждения</option>
            <option value="error">Ошибки</option>
          </select>
          <button onClick={() => void load()} className="p-2 rounded-full bg-paper text-muted hover:text-ink" title="Обновить"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </div>

      <div className="divide-y divide-line border-y border-line">
        {page.items.map((event) => {
          const Icon = icons[event.level];
          return (
            <div key={event.id} className="py-3 flex items-start gap-3">
              <span className={`p-1.5 rounded-lg shrink-0 ${colors[event.level]}`}><Icon className="w-4 h-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink break-words">{event.message}</div>
                <div className="text-xs text-faint mt-1 font-mono">{event.type}{event.entity_kind ? ` · ${event.entity_kind} #${event.entity_id}` : ''}</div>
              </div>
              <time className="text-xs text-muted whitespace-nowrap">{new Date(`${event.created_at}Z`).toLocaleString('ru-RU')}</time>
              <span className="sr-only">{labels[event.level]}</span>
            </div>
          );
        })}
        {!loading && page.items.length === 0 && <div className="py-12 text-center text-sm text-muted">Событий пока нет</div>}
      </div>

      <div className="flex items-center justify-between text-sm text-muted">
        <span>{page.total ? `${offset + 1}–${Math.min(offset + limit, page.total)} из ${page.total}` : '0 событий'}</span>
        <div className="flex gap-2">
          <button aria-label="Предыдущая страница" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} className="p-2 rounded-full bg-paper disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
          <button aria-label="Следующая страница" disabled={offset + limit >= page.total} onClick={() => setOffset(offset + limit)} className="p-2 rounded-full bg-paper disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
        </div>
      </div>
    </section>
  );
};
