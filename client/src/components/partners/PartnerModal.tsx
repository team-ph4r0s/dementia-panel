import React, { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import type { Partner, Server } from '../../types';
import { api } from '../../api';
import { GIB } from '../../utils';
import { ModalShell } from '../ui/Modal';
import { inputClass, toDateInput } from './shared';

export const PartnerModal: React.FC<{
  partner: Partner | null;
  servers: Server[];
  onClose: () => void;
  onSaved: (result: { partner: Partner; connectString?: string }) => void;
}> = ({ partner, servers, onClose, onSaved }) => {
  const ownServers = servers.filter((s) => !s.remote_panel_id);
  const [name, setName] = useState(partner?.name ?? '');
  const [nodeIds, setNodeIds] = useState<number[]>(partner?.node_ids ?? []);
  const [maxClients, setMaxClients] = useState(partner?.max_clients ? String(partner.max_clients) : '');
  const [limitGb, setLimitGb] = useState(partner?.traffic_limit ? String(+(partner.traffic_limit / GIB).toFixed(2)) : '');
  const [expireDate, setExpireDate] = useState(toDateInput(partner?.expire_at ?? null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleNode = (id: number) => setNodeIds((prev) => (prev.includes(id) ? prev.filter((n) => n !== id) : [...prev, id]));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const data = {
      name: name.trim(),
      node_ids: nodeIds,
      max_clients: maxClients.trim() ? parseInt(maxClients, 10) : 0,
      traffic_limit: limitGb.trim() ? Math.round(parseFloat(limitGb.replace(',', '.')) * GIB) : 0,
      expire_at: expireDate ? new Date(`${expireDate}T23:59:59`).toISOString() : null,
    };
    try {
      if (partner) {
        onSaved({ partner: await api.updatePartner(partner.id, data) });
      } else {
        const created = await api.createPartner(data);
        onSaved({ partner: created.partner, connectString: created.connect_string });
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell label="Партнёрский доступ" onClose={onClose}>
      <form onSubmit={handleSubmit} className="bg-card border border-line rounded-2xl w-full max-w-lg shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 className="text-base font-semibold text-ink">{partner ? 'Изменить доступ партнёра' : 'Выдать доступ к нодам'}</h2>
          <button type="button" onClick={onClose} className="text-muted hover:text-ink p-1 rounded-lg hover:bg-soft border border-line">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          {error && <div className="p-3 bg-bad-soft border border-line rounded-xl text-bad text-xs">{error}</div>}
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Партнёр</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="например: Панель Пети" className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Доступные ноды</label>
            {ownServers.length === 0 ? (
              <p className="text-xs text-faint">Нет своих нод.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {ownServers.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-xs text-ink bg-paper border border-line rounded-xl px-3 py-2 cursor-pointer">
                    <input type="checkbox" checked={nodeIds.includes(s.id)} onChange={() => toggleNode(s.id)} />
                    <span className="font-medium">{s.name}</span>
                    <span className="font-mono text-faint">{s.host}</span>
                    {s.status === 'uninstalled' && <span className="text-warn">не установлена</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Макс. клиентов</label>
              <input type="number" min={0} value={maxClients} onChange={(e) => setMaxClients(e.target.value)} placeholder="без лимита" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Трафик, ГБ</label>
              <input type="number" min={0} step="0.1" value={limitGb} onChange={(e) => setLimitGb(e.target.value)} placeholder="без лимита" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Действует до</label>
              <input type="date" value={expireDate} onChange={(e) => setExpireDate(e.target.value)} className={inputClass} />
            </div>
          </div>
          <p className="text-xs text-faint">
            Партнёр сможет создавать клиентов на выбранных нодах из своей панели. Приватные ключи его клиентов к вам не попадают;
            вы видите клиентов, их трафик и можете блокировать их.
          </p>
        </div>
        <div className="px-6 py-3 border-t border-line flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-ink">
            Отмена
          </button>
          <button type="submit" disabled={saving} className="flex items-center gap-2 bg-brand hover:bg-brand disabled:opacity-50 text-on-accent text-sm font-bold px-5 py-2 rounded-lg btn-press hover:text-on-accent">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>{partner ? 'Сохранить' : 'Создать доступ'}</span>
          </button>
        </div>
      </form>
    </ModalShell>
  );
};
