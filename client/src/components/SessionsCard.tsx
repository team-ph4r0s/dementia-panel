import React, { useEffect, useState } from 'react';
import { Monitor, Trash2 } from 'lucide-react';
import { api } from '../api';

type Session = Awaited<ReturnType<typeof api.getSessions>>[number];

export const SessionsCard: React.FC = () => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState('');

  const load = async () => {
    try { setSessions(await api.getSessions()); setError(''); } catch (err: any) { setError(err.message); }
  };

  useEffect(() => { void Promise.resolve().then(load); }, []);

  const revoke = async (id: number) => {
    try { await api.revokeSession(id); await load(); } catch (err: any) { setError(err.message); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-ink"><Monitor className="w-4 h-4 text-info" />Активные сессии</div>
      {error && <div className="p-3 bg-bad-soft rounded-xl text-bad text-xs">{error}</div>}
      <div className="space-y-2 max-h-72 overflow-y-auto">
        {sessions.map((session) => (
          <div key={session.id} className="p-3 bg-paper border border-line rounded-xl flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-ink truncate">{session.user_agent}</div>
              <div className="text-xs text-muted mt-1">{session.ip} · {new Date(session.last_activity).toLocaleString('ru-RU')}</div>
              {session.current && <div className="text-xs text-ok mt-1">Текущая сессия</div>}
              {session.role === 'guest' && <div className="text-xs text-info mt-1">Гостевой доступ (только просмотр)</div>}
            </div>
            <button type="button" aria-label="Завершить сессию" onClick={() => void revoke(session.id)} className="p-2 text-muted hover:text-bad"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
      </div>
    </div>
  );
};
