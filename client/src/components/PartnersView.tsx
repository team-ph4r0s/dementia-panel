import React, { useCallback, useEffect, useState } from 'react';
import { Handshake, Plus, KeyRound, Trash2, Pencil, Power, RefreshCw, ChevronDown, ChevronRight, Link2, Unplug, Loader2 } from 'lucide-react';
import type { Partner, RemotePanel, Server } from '../types';
import { api } from '../api';
import { formatBytes } from '../utils';
import { useFeedback } from './ui/feedback-context';
import { cardClass, inputClass, iconButton, formatDate } from './partners/shared';
import { PartnerModal } from './partners/PartnerModal';
import { TokenModal } from './partners/TokenModal';
import { PartnerDetails } from './partners/PartnerDetails';

export const PartnersView: React.FC<{ servers: Server[]; publicUrl: string | null; onChanged: () => void }> = ({
  servers,
  onChanged,
}) => {
  const { toast, confirm } = useFeedback();
  const [partners, setPartners] = useState<Partner[]>([]);
  const [panels, setPanels] = useState<RemotePanel[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalPartner, setModalPartner] = useState<Partner | null | undefined>(undefined);
  const [connectString, setConnectString] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [connectInput, setConnectInput] = useState('');
  const [connectName, setConnectName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.getPartners(), api.getRemotePanels()]);
      setPartners(p);
      setPanels(r);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const serverName = (id: number) => servers.find((s) => s.id === id)?.name || `#${id}`;

  const togglePartner = async (partner: Partner) => {
    if (partner.enabled && !(await confirm({ message: `Отключить доступ «${partner.name}»? Все его клиенты на ваших нодах перестанут работать.`, danger: true, confirmLabel: 'Отключить' }))) return;
    try {
      await api.updatePartner(partner.id, { enabled: !partner.enabled });
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const regenerate = async (partner: Partner) => {
    if (!(await confirm({ message: `Перевыпустить токен «${partner.name}»? Старый токен перестанет работать — партнёру нужно будет переподключить панель.`, danger: true, confirmLabel: 'Перевыпустить' }))) return;
    try {
      const res = await api.regeneratePartnerToken(partner.id);
      setConnectString(res.connect_string);
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const removePartner = async (partner: Partner) => {
    if (!(await confirm({ message: `Удалить доступ «${partner.name}»? Все клиенты партнёра будут удалены с ваших нод.`, danger: true, confirmLabel: 'Удалить' }))) return;
    try {
      await api.deletePartner(partner.id);
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    try {
      await api.connectRemotePanel(connectInput.trim(), connectName.trim() || undefined);
      setConnectInput('');
      setConnectName('');
      await load();
      onChanged();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setConnecting(false);
    }
  };

  const syncPanel = async (panel: RemotePanel) => {
    setSyncing(panel.id);
    try {
      await api.syncRemotePanel(panel.id);
      await load();
      onChanged();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setSyncing(null);
    }
  };

  const disconnectPanel = async (panel: RemotePanel) => {
    if (!(await confirm({ message: `Отключить панель «${panel.name}»? Её ноды пропадут из подписок, а ваши клиенты на них будут удалены.`, danger: true, confirmLabel: 'Отключить' }))) return;
    try {
      const res = await api.disconnectRemotePanel(panel.id);
      if (!res.remoteCleanup) toast('Панель отключена, но удалить клиентов на стороне партнёра не удалось — сообщите ему.', 'error');
      await load();
      onChanged();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  if (loading) return <div className="flex items-center justify-center py-24 text-faint text-sm">Загрузка...</div>;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-ink flex items-center gap-2">
          <Handshake className="w-5 h-5 text-warn" />
          <span>Партнёры</span>
        </h2>
        <p className="text-xs text-muted mt-0.5">
          Совместное использование нод между панелями: выдайте другу доступ к своим нодам или подключите ноды, которыми поделились с вами.
        </p>
      </div>

      {/* Выданные доступы */}
      <div className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">Доступ к моим нодам</h3>
            <p className="text-xs text-faint">Партнёры создают клиентов на ваших нодах из своих панелей</p>
          </div>
          <button
            onClick={() => setModalPartner(null)}
            className="flex items-center gap-1.5 bg-brand hover:bg-brand text-on-accent text-xs font-bold px-3.5 py-2 rounded-lg btn-press hover:text-on-accent"
          >
            <Plus className="w-4 h-4" />
            <span>Выдать доступ</span>
          </button>
        </div>

        {partners.length === 0 ? (
          <p className="text-xs text-faint py-4 text-center border border-dashed border-line rounded-xl">Доступы ещё не выданы</p>
        ) : (
          <div className="divide-y divide-line">
            {partners.map((p) => {
              const status = !p.enabled ? 'отключён' : p.expired ? 'срок истёк' : p.suspended ? 'лимит исчерпан' : 'активен';
              const ok = status === 'активен';
              return (
                <div key={p.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <button data-guest-ok onClick={() => setExpanded(expanded === p.id ? null : p.id)} className="text-faint hover:text-ink">
                      {expanded === p.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-ink">{p.name}</span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${
                            ok ? 'bg-ok-soft text-ok border-line' : 'bg-warn-soft text-warn border-line'
                          }`}
                        >
                          {status}
                        </span>
                        <span className="text-xs font-mono text-faint">{p.token_hint}</span>
                      </div>
                      <div className="text-xs text-faint mt-0.5 space-x-3">
                        <span>ноды: {p.node_ids.map(serverName).join(', ') || '—'}</span>
                        <span>
                          клиенты: {p.usage.clients}
                          {p.max_clients ? ` / ${p.max_clients}` : ''}
                        </span>
                        <span>
                          трафик: {formatBytes(p.usage.used)}
                          {p.traffic_limit ? ` / ${formatBytes(p.traffic_limit)}` : ''}
                        </span>
                        {p.expire_at && <span>до {new Date(p.expire_at).toLocaleDateString()}</span>}
                        <span>последний запрос: {formatDate(p.last_used_at)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setModalPartner(p)} title="Изменить" className={`${iconButton} hover:text-info`}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => regenerate(p)} title="Перевыпустить токен" className={`${iconButton} hover:text-warn`}>
                        <KeyRound className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => togglePartner(p)}
                        title={p.enabled ? 'Отключить доступ' : 'Включить доступ'}
                        className={`${iconButton} ${p.enabled ? 'hover:text-warn' : 'text-warn hover:text-ok'}`}
                      >
                        <Power className="w-4 h-4" />
                      </button>
                      <button onClick={() => removePartner(p)} title="Удалить доступ" className={`${iconButton} hover:text-bad`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {expanded === p.id && <PartnerDetails partner={p} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Подключённые панели */}
      <div className={cardClass}>
        <div>
          <h3 className="text-sm font-semibold text-ink">Ноды партнёров</h3>
          <p className="text-xs text-faint">
            Вставьте строку подключения, которую выдал владелец нод. Его ноды появятся в списке серверов, и вы сможете выдавать их своим пользователям.
          </p>
        </div>

        <form onSubmit={handleConnect} className="flex flex-col sm:flex-row gap-2">
          <input
            required
            value={connectInput}
            onChange={(e) => setConnectInput(e.target.value)}
            placeholder="https://panel.example.com#dp_…"
            className={`${inputClass} font-mono text-xs flex-1`}
          />
          <input value={connectName} onChange={(e) => setConnectName(e.target.value)} placeholder="Название (необязательно)" className={`${inputClass} sm:w-56`} />
          <button
            type="submit"
            disabled={connecting}
            className="flex items-center justify-center gap-1.5 bg-brand hover:bg-brand disabled:opacity-50 text-on-accent text-xs font-bold px-4 py-2 rounded-lg btn-press hover:text-on-accent"
          >
            {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
            <span>Подключить</span>
          </button>
        </form>

        {panels.length === 0 ? (
          <p className="text-xs text-faint py-4 text-center border border-dashed border-line rounded-xl">Панели партнёров не подключены</p>
        ) : (
          <div className="divide-y divide-line">
            {panels.map((panel) => {
              const statusLabel =
                panel.status === 'online' ? 'на связи' : panel.status === 'revoked' ? 'доступ отозван' : panel.status === 'pending' ? 'подключение' : 'ошибка';
              return (
                <div key={panel.id} className="py-3 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink">{panel.name}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${
                          panel.status === 'online'
                            ? 'bg-ok-soft text-ok border-line'
                            : 'bg-warn-soft text-warn border-line'
                        }`}
                      >
                        {statusLabel}
                      </span>
                      <span className="text-xs font-mono text-faint">{panel.base_url}</span>
                    </div>
                    <div className="text-xs text-faint mt-0.5 space-x-3">
                      <span>ноды: {panel.node_count}</span>
                      <span>
                        клиенты: {panel.client_count}
                        {panel.limits?.max_clients ? ` / ${panel.limits.max_clients}` : ''}
                      </span>
                      {panel.limits && (
                        <span>
                          трафик: {formatBytes(panel.limits.usage.used)}
                          {panel.limits.traffic_limit ? ` / ${formatBytes(panel.limits.traffic_limit)}` : ''}
                        </span>
                      )}
                      {panel.limits?.expire_at && <span>до {new Date(panel.limits.expire_at).toLocaleDateString()}</span>}
                      <span>синхронизация: {formatDate(panel.last_sync_at)}</span>
                    </div>
                    {panel.last_error && <p className="text-xs text-warn mt-1 break-all">{panel.last_error}</p>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => syncPanel(panel)} disabled={syncing === panel.id} title="Синхронизировать" className={`${iconButton} hover:text-ok`}>
                      <RefreshCw className={`w-4 h-4 ${syncing === panel.id ? 'animate-spin' : ''}`} />
                    </button>
                    <button onClick={() => disconnectPanel(panel)} title="Отключить панель" className={`${iconButton} hover:text-bad`}>
                      <Unplug className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modalPartner !== undefined && (
        <PartnerModal
          partner={modalPartner}
          servers={servers}
          onClose={() => setModalPartner(undefined)}
          onSaved={({ connectString: cs }) => {
            setModalPartner(undefined);
            if (cs) setConnectString(cs);
            load();
          }}
        />
      )}
      {connectString && <TokenModal connectString={connectString} onClose={() => setConnectString(null)} />}
    </div>
  );
};
