import React, { useEffect, useMemo, useState } from 'react';
import {
  QrCode,
  Download,
  Trash2,
  Power,
  Search,
  Plus,
  ArrowDownRight,
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  Clock,
  Laptop,
} from 'lucide-react';
import type { Client, NodeProtocol } from '../types';
import { api } from '../api';
import { formatBytes } from '../utils';
import { useFeedback } from './ui/feedback-context';
import { sortClients, clientStatus, type ClientSortKey, type SortDirection } from './clientSort';

interface ClientListProps {
  clients: Client[];
  serverName: string;
  serverOnline?: boolean;
  protocol?: NodeProtocol;
  /** table — таблица на всю ширину, cards — узкие карточки (панель справа от карты) */
  layout?: 'table' | 'cards';
  onAddClient: () => void;
  onShowQr: (clientId: number) => void;
  onClientUpdated: (client: Client) => void;
  onClientDeleted: (clientId: number) => void;
}

const PAGE_SIZE = 25;

const SORT_LABELS: Record<ClientSortKey, string> = {
  name: 'Имя',
  ip: 'IP',
  status: 'Статус',
  traffic: 'Трафик',
  activity: 'Активность',
};

const STATUS_BADGE = {
  online: { text: 'Онлайн', className: 'bg-ok-soft text-ok', pulse: true },
  idle: { text: 'Неактивен', className: 'bg-soft text-muted', pulse: false },
  disabled: { text: 'Отключен', className: 'bg-soft text-muted', pulse: false },
} as const;

export const ClientList: React.FC<ClientListProps> = ({
  clients,
  serverName,
  protocol = 'awg',
  layout = 'table',
  onAddClient,
  onShowQr,
  onClientUpdated,
  onClientDeleted,
}) => {
  const vless = protocol === 'vless';
  const { toast, confirm } = useFeedback();
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [sortKey, setSortKey] = useState<ClientSortKey>('activity');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const formatLastHandshake = (dateStr: string | null) => {
    if (!dateStr) return 'Никогда';
    const date = new Date(dateStr);
    const diffSec = Math.max(0, Math.floor((now - date.getTime()) / 1000));

    if (diffSec < 60) return `${diffSec} сек назад`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} мин назад`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} ч назад`;
    return date.toLocaleDateString();
  };

  const isActive = (client: Client) => (client.partner_name ? !client.owner_blocked : Boolean(client.enabled));

  const toggleClient = async (client: Client) => {
    // Для клиента партнёра переключатель блокирует/разблокирует его владельцем
    const updated = await api.updateClient(client.id, { enabled: isActive(client) ? 0 : 1 });
    onClientUpdated(updated);
  };

  const handleToggle = async (client: Client) => {
    try {
      await toggleClient(client);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const handleDownload = async (client: Client) => {
    try {
      await api.downloadClientConfig(client.id, client.name, protocol);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const handleDelete = async (client: Client) => {
    if (!(await confirm({ message: `Удалить клиента "${client.name}"?`, danger: true, confirmLabel: 'Удалить' }))) return;
    try {
      await api.deleteClient(client.id);
      onClientDeleted(client.id);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? clients.filter((c) => c.name.toLowerCase().includes(q) || c.client_ip.includes(q)) : clients;
    return sortClients(list, sortKey, sortDir, now);
  }, [clients, search, sortKey, sortDir, now]);

  // Выбранные клиенты, которых уже нет в списке (удалены или сменили ноду), в выборке не учитываются
  const selectedClients = useMemo(() => clients.filter((c) => selected.has(c.id)), [clients, selected]);
  const shown = filtered.slice(0, visible);
  const allShownSelected = shown.length > 0 && shown.every((c) => selected.has(c.id));

  const changeSort = (key: ClientSortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'traffic' || key === 'activity' ? 'desc' : 'asc');
    }
  };

  const toggleSelected = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) shown.forEach((c) => next.delete(c.id));
      else shown.forEach((c) => next.add(c.id));
      return next;
    });

  /** Массовое включение/отключение: клиенты в нужном состоянии пропускаются, ошибки не прерывают остальных */
  const bulkToggle = async (enable: boolean) => {
    const targets = selectedClients.filter((c) => isActive(c) !== enable);
    if (targets.length === 0) {
      toast(enable ? 'Все выбранные клиенты уже включены' : 'Все выбранные клиенты уже отключены', 'info');
      return;
    }
    setBulkBusy(true);
    let done = 0;
    let failed = 0;
    for (const client of targets) {
      try {
        await toggleClient(client);
        done++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    toast(`${enable ? 'Включено' : 'Отключено'}: ${done}${failed ? `, с ошибкой: ${failed}` : ''}`, failed ? 'error' : 'success');
  };

  const bulkDelete = async () => {
    // Клиентов партнёров удалить нельзя — только заблокировать
    const targets = selectedClients.filter((c) => !c.partner_name);
    const skipped = selectedClients.length - targets.length;
    if (targets.length === 0) {
      toast('Клиентов партнёров можно только блокировать, а не удалять', 'info');
      return;
    }
    const note = skipped > 0 ? `\n\nКлиентов партнёров (${skipped}) это не затронет: их можно только заблокировать.` : '';
    if (!(await confirm({ message: `Удалить клиентов: ${targets.length}? Действие необратимо.${note}`, danger: true, confirmLabel: 'Удалить' }))) return;
    setBulkBusy(true);
    let done = 0;
    let failed = 0;
    for (const client of targets) {
      try {
        await api.deleteClient(client.id);
        onClientDeleted(client.id);
        done++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    setSelected(new Set());
    toast(`Удалено: ${done}${failed ? `, с ошибкой: ${failed}` : ''}`, failed ? 'error' : 'success');
  };

  const badges = (client: Client) => (
    <>
      {client.partner_name && (
        <span
          className="px-1.5 py-0.5 rounded text-xs font-medium bg-warn-soft text-warn border border-line"
          title="Клиент создан панелью партнёра. Его можно заблокировать, но не удалить."
        >
          партнёр: {client.partner_name}
        </span>
      )}
      {client.pending && (
        <span
          className="px-1.5 py-0.5 rounded text-xs font-medium bg-soft text-muted border border-line"
          title={client.remote_state?.startsWith('error') ? client.remote_state.slice(7) : 'Ожидает создания на ноде партнёра'}
        >
          {client.remote_state?.startsWith('error') ? 'ошибка у владельца' : 'создаётся'}
        </span>
      )}
      {client.remote_state === 'blocked' && (
        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-bad-soft text-bad border border-line">заблокирован владельцем</span>
      )}
      {client.external && (
        <span
          className="px-1.5 py-0.5 rounded text-xs font-medium bg-soft text-muted border border-line"
          title="Импортирован из существующей установки: конфигурация и QR-код недоступны"
        >
          импорт
        </span>
      )}
    </>
  );

  const actions = (client: Client) => {
    const keyless = client.external || Boolean(client.partner_name) || client.pending;
    const disabled = !client.enabled || client.owner_blocked;
    const toggleTitle = !disabled
      ? client.partner_name ? 'Заблокировать клиента партнёра' : 'Отключить пира'
      : client.partner_name ? 'Разблокировать' : 'Включить пира';
    const keylessTitle = 'Конфигурация недоступна для этого клиента';
    return (
      <div className="flex items-center justify-end gap-1.5">
        <button
          onClick={() => onShowQr(client.id)}
          disabled={keyless}
          title={keyless ? keylessTitle : 'Показать QR-код'}
          aria-label={`QR-код клиента ${client.name}`}
          className="p-1.5 text-muted hover:text-brand hover:bg-soft rounded-lg transition border border-line disabled:opacity-40"
        >
          <QrCode className="w-4 h-4" />
        </button>
        <button
          onClick={() => handleDownload(client)}
          disabled={keyless}
          title={keyless ? keylessTitle : vless ? 'Скачать ссылку VLESS (.txt)' : 'Скачать .conf'}
          aria-label={`Скачать конфигурацию клиента ${client.name}`}
          className="p-1.5 text-muted hover:text-info hover:bg-soft rounded-lg transition border border-line disabled:opacity-40"
        >
          <Download className="w-4 h-4" />
        </button>
        <button
          onClick={() => handleToggle(client)}
          title={toggleTitle}
          aria-label={`${toggleTitle}: ${client.name}`}
          className={`p-1.5 rounded-lg transition border border-line ${!disabled ? 'text-muted hover:text-warn hover:bg-soft' : 'text-warn hover:text-ok hover:bg-soft'}`}
        >
          <Power className="w-4 h-4" />
        </button>
        {!client.partner_name && (
          <button
            onClick={() => handleDelete(client)}
            title="Удалить пира"
            aria-label={`Удалить клиента ${client.name}`}
            className="p-1.5 text-muted hover:text-bad hover:bg-soft rounded-lg transition border border-line"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    );
  };

  const statusBadge = (client: Client) => {
    const badge = STATUS_BADGE[clientStatus(client, now)];
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${badge.className}`}>
        {badge.pulse && <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />}
        {badge.text}
      </span>
    );
  };

  const traffic = (client: Client) => (
    <div className="flex items-center gap-3 font-mono">
      <span className="flex items-center gap-1 text-ok" title="Получено клиентом">
        <ArrowDownRight className="w-3.5 h-3.5" />
        {formatBytes(client.total_tx)}
      </span>
      <span className="flex items-center gap-1 text-info" title="Отправлено клиентом">
        <ArrowUpRight className="w-3.5 h-3.5" />
        {formatBytes(client.total_rx)}
      </span>
    </div>
  );

  const dot = (client: Client) => {
    const status = clientStatus(client, now);
    return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${status === 'online' ? 'bg-ok' : 'bg-faint'}`} />;
  };

  const sortHeader = (key: ClientSortKey, className = '') => (
    <th
      className={`pb-3 font-medium ${className}`}
      aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button onClick={() => changeSort(key)} className={`inline-flex items-center gap-1 hover:text-ink transition ${sortKey === key ? 'text-brand' : ''}`}>
        {SORT_LABELS[key]}
        {sortKey === key && (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </th>
  );

  const selectBox = (client: Client) => (
    <input
      type="checkbox"
      checked={selected.has(client.id)}
      onChange={() => toggleSelected(client.id)}
      aria-label={`Выбрать клиента ${client.name}`}
    />
  );

  return (
    <div className="bg-card border border-line rounded-2xl p-5 shadow-pop space-y-4">
      {/* Заголовок и поиск */}
      <div className={`flex flex-col justify-between gap-3 ${layout === 'cards' ? '' : 'sm:flex-row sm:items-center'}`}>
        <div>
          <h3 className="text-base font-semibold text-ink flex items-center gap-2">
            <span>{vless ? 'Клиенты VLESS' : 'Клиенты AmneziaWG'}</span>
            <span className="text-xs font-mono text-muted bg-soft px-2 py-0.5 rounded-full border border-line">{clients.length}</span>
          </h3>
          <p className="text-xs text-muted mt-0.5">{vless ? 'Устройства сервера' : 'Пиры и устройства сервера'} {serverName}</p>
        </div>

        <div className="flex items-center gap-2">
          <div className={`relative ${layout === 'cards' ? 'flex-1' : ''}`} data-guest-ok>
            <input
              type="text"
              placeholder={vless ? 'Имя...' : 'Имя или IP...'}
              aria-label="Поиск клиентов"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisible(PAGE_SIZE);
              }}
              className={`bg-paper border border-line rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink placeholder-faint focus:outline-none focus:border-brand transition ${layout === 'cards' ? 'w-full' : 'w-40 sm:w-52'}`}
            />
            <Search className="w-3.5 h-3.5 text-faint absolute left-2.5 top-2" />
          </div>

          <button
            onClick={onAddClient}
            className="flex items-center gap-1.5 bg-brand text-on-accent font-bold text-xs px-3.5 py-1.5 rounded-lg transition btn-press"
          >
            <Plus className="w-4 h-4" />
            <span>Клиент</span>
          </button>
        </div>
      </div>

      {/* Массовые действия */}
      {selectedClients.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-brand-soft border border-brand/30 rounded-lg px-3 py-2 text-xs" role="region" aria-label="Массовые действия">
          <span className="text-brand font-semibold">Выбрано: {selectedClients.length}</span>
          <button disabled={bulkBusy} onClick={() => bulkToggle(true)} className="px-2.5 py-1 rounded-md bg-soft text-ink hover:bg-soft-2 transition disabled:opacity-50">
            Включить
          </button>
          <button disabled={bulkBusy} onClick={() => bulkToggle(false)} className="px-2.5 py-1 rounded-md bg-soft text-ink hover:bg-soft-2 transition disabled:opacity-50">
            Отключить
          </button>
          <button disabled={bulkBusy} onClick={bulkDelete} className="px-2.5 py-1 rounded-md bg-soft text-bad hover:bg-bad-soft transition disabled:opacity-50">
            Удалить
          </button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-muted hover:text-ink transition">
            Снять выбор
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-line rounded-xl">
          <Laptop className="w-10 h-10 text-faint mx-auto mb-2" />
          <p className="text-sm font-medium text-muted">{clients.length === 0 ? 'Нет добавленных клиентов' : 'Никого не нашли'}</p>
          {clients.length === 0 && <p className="text-xs text-faint mt-1">Нажмите «Клиент», чтобы сгенерировать конфигурацию и QR-код</p>}
        </div>
      ) : layout === 'table' ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead data-guest-ok>
              <tr className="border-b border-line text-muted">
                <th className="pb-3 w-8">
                  <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} aria-label="Выбрать всех показанных клиентов" />
                </th>
                {sortHeader('name')}
                {vless ? <th className="pb-3 font-medium">Протокол</th> : sortHeader('ip')}
                {sortHeader('status')}
                {sortHeader('traffic')}
                {sortHeader('activity')}
                <th className="pb-3 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((client) => (
                <tr key={client.id} className={`hover:bg-soft transition ${selected.has(client.id) ? 'bg-brand-soft' : ''}`}>
                  <td className="py-3 pr-2">{selectBox(client)}</td>
                  <td className="py-3 font-medium text-ink">
                    <div className="flex items-center gap-2 flex-wrap">
                      {dot(client)}
                      <span>{client.name}</span>
                      {badges(client)}
                    </div>
                  </td>
                  <td className="py-3 font-mono text-ink">{vless ? 'VLESS' : client.client_ip}</td>
                  <td className="py-3">{statusBadge(client)}</td>
                  <td className="py-3 text-ink">{traffic(client)}</td>
                  <td className="py-3 text-muted">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-faint" />
                      <span>{formatLastHandshake(client.last_handshake)}</span>
                    </div>
                  </td>
                  <td className="py-3 text-right">{actions(client)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 pb-2 text-xs text-muted" data-guest-ok>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} aria-label="Выбрать всех показанных клиентов" />
              Все
            </label>
            <span className="ml-auto">Сортировка:</span>
            <select
              value={sortKey}
              onChange={(e) => changeSort(e.target.value as ClientSortKey)}
              aria-label="Сортировка клиентов"
              className="bg-paper border border-line rounded-lg px-2 py-1 text-xs text-ink"
            >
              {(Object.keys(SORT_LABELS) as ClientSortKey[]).filter((key) => !vless || key !== 'ip').map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
            <button
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
              aria-label={sortDir === 'asc' ? 'По возрастанию' : 'По убыванию'}
              title={sortDir === 'asc' ? 'По возрастанию' : 'По убыванию'}
              className="p-1.5 rounded-lg border border-line text-muted hover:text-ink transition"
            >
              {sortDir === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
            </button>
          </div>
          <ul className="divide-y divide-line text-xs">
            {shown.map((client) => (
              <li key={client.id} className={`py-3 space-y-2 ${selected.has(client.id) ? 'bg-brand-soft -mx-2 px-2 rounded-lg' : ''}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  {selectBox(client)}
                  {dot(client)}
                  <span className="font-medium text-ink text-sm">{client.name}</span>
                  {badges(client)}
                  <span className="ml-auto">{statusBadge(client)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap pl-6">
                  <span className="font-mono text-ink">{vless ? 'VLESS' : client.client_ip}</span>
                  {traffic(client)}
                  <span className="flex items-center gap-1 text-muted">
                    <Clock className="w-3.5 h-3.5 text-faint" />
                    {formatLastHandshake(client.last_handshake)}
                  </span>
                </div>
                <div className="pl-6">{actions(client)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {filtered.length > visible && (
        <div className="flex justify-center" data-guest-ok>
          <button onClick={() => setVisible((v) => v + PAGE_SIZE)} className="px-4 py-1.5 rounded-lg bg-soft text-muted hover:text-ink hover:bg-soft-2 text-xs font-medium transition">
            Показать ещё ({filtered.length - visible})
          </button>
        </div>
      )}
    </div>
  );
};
