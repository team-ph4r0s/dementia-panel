import React, { useState } from 'react';
import {
  Link2,
  Trash2,
  Power,
  Search,
  Plus,
  ArrowDownRight,
  ArrowUpRight,
  Server as ServerIcon,
  Users,
  Settings,
  RotateCcw,
} from 'lucide-react';
import type { Subscriber } from '../types';
import { api } from '../api';
import { countryFlag, countryName, formatBytes } from '../utils';
import { useFeedback } from './ui/feedback-context';

interface SubscribersListProps {
  subscribers: Subscriber[];
  onAddSubscriber: () => void;
  onEditSubscriber: (sub: Subscriber) => void;
  onShowSubscription: (sub: Subscriber) => void;
  onSubscriberUpdated: (sub: Subscriber) => void;
  onSubscriberDeleted: (id: number) => void;
}

export const SubscribersList: React.FC<SubscribersListProps> = ({
  subscribers,
  onAddSubscriber,
  onEditSubscriber,
  onShowSubscription,
  onSubscriberUpdated,
  onSubscriberDeleted,
}) => {
  const { toast, confirm } = useFeedback();
  const [search, setSearch] = useState('');

  const handleToggle = async (sub: Subscriber) => {
    try {
      const updated = await api.updateSubscriber(sub.id, {
        enabled: sub.enabled ? 0 : 1,
      });
      onSubscriberUpdated(updated);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const handleResetTraffic = async (sub: Subscriber) => {
    if (!(await confirm(`Обнулить счётчик трафика пользователя "${sub.name}"?`))) return;
    try {
      onSubscriberUpdated(await api.resetSubscriberTraffic(sub.id));
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const handleDelete = async (sub: Subscriber) => {
    if (!(await confirm({ message: `Удалить пользователя "${sub.name}" и все его конфигурации на серверах?`, danger: true, confirmLabel: 'Удалить' }))) return;
    try {
      await api.deleteSubscriber(sub.id);
      onSubscriberDeleted(sub.id);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const filteredSubscribers = subscribers.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="bg-card border border-line rounded-2xl p-6 shadow-pop space-y-5">
      {/* Table Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-ink flex items-center gap-2">
            <span>Пользователи и подписки (Incy)</span>
            <span className="text-xs font-mono text-muted bg-soft px-2 py-0.5 rounded-full border border-line">
              {subscribers.length}
            </span>
          </h3>
          <p className="text-xs text-muted mt-0.5">
            Управление доступом к нодам и единые автообновляемые ссылки подписок
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative" data-guest-ok>
            <input
              type="text"
              placeholder="Поиск по имени..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-paper border border-line rounded-xl pl-8 pr-3 py-1.5 text-xs text-ink placeholder-faint focus:outline-none focus:border-brand w-48 sm:w-60 transition"
            />
            <Search className="w-3.5 h-3.5 text-faint absolute left-2.5 top-2" />
          </div>

          <button
            onClick={onAddSubscriber}
            className="flex items-center gap-1.5 bg-brand text-on-accent font-bold text-xs px-3.5 py-1.5 rounded-lg transition btn-press"
          >
            <Plus className="w-4 h-4" />
            <span>Новый пользователь</span>
          </button>
        </div>
      </div>

      {/* Subscribers Table */}
      {filteredSubscribers.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-line rounded-xl">
          <Users className="w-10 h-10 text-faint mx-auto mb-2" />
          <p className="text-sm font-medium text-muted">Нет созданных пользователей</p>
          <p className="text-xs text-faint mt-1">
            Нажмите «Новый пользователь», чтобы настроить доступ к серверам и создать ссылку подписки
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="pb-3 font-medium">Пользователь</th>
                <th className="pb-3 font-medium">Доступные ноды (серверы)</th>
                <th className="pb-3 font-medium">Статус</th>
                <th className="pb-3 font-medium">Суммарный трафик</th>
                <th className="pb-3 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredSubscribers.map((sub) => {
                const disabled = !sub.enabled;

                return (
                  <tr key={sub.id} className="hover:bg-soft transition">
                    {/* Name */}
                    <td className="py-3 font-medium text-ink flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-ok flex-shrink-0" />
                      <span>{sub.name}</span>
                      {sub.country && (
                        <span title={`Страна: ${countryName(sub.country)}`} className="text-sm leading-none">
                          {countryFlag(sub.country)}
                        </span>
                      )}
                    </td>

                    {/* Servers Badges */}
                    <td className="py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {sub.servers && sub.servers.length > 0 ? (
                          sub.servers.map((s) => (
                            <span
                              key={s.id}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-paper border border-line text-ink"
                            >
                              <ServerIcon className="w-3 h-3 text-ok" />
                              <span>{s.name}</span>
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-faint italic">Нет доступа к нодам</span>
                        )}
                      </div>
                    </td>

                    {/* Status Badge */}
                    <td className="py-3">
                      {disabled ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-soft text-muted border border-line">
                          Отключен
                        </span>
                      ) : sub.suspended ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-warn-soft text-warn border border-line">
                          {sub.expired ? 'Срок истёк' : 'Лимит исчерпан'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-ok-soft text-ok border border-line">
                          <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
                          Активен
                        </span>
                      )}
                    </td>

                    {/* Traffic */}
                    <td className="py-3 text-ink font-mono">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1 text-ok" title="Получено пользователем">
                          <ArrowDownRight className="w-3.5 h-3.5" />
                          {formatBytes(sub.total_tx)}
                        </span>
                        <span className="flex items-center gap-1 text-info" title="Отправлено пользователем">
                          <ArrowUpRight className="w-3.5 h-3.5" />
                          {formatBytes(sub.total_rx)}
                        </span>
                      </div>
                      {(sub.traffic_limit > 0 || sub.expire_at) && (
                        <div className="text-xs text-faint mt-1 space-x-2">
                          {sub.traffic_limit > 0 && (
                            <span>{formatBytes(sub.traffic_used)} из {formatBytes(sub.traffic_limit)}</span>
                          )}
                          {sub.expire_at && <span>до {new Date(sub.expire_at).toLocaleDateString()}</span>}
                        </div>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Subscription Link & QR Modal */}
                        <button
                          onClick={() => onShowSubscription(sub)}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-ok-soft hover:bg-ok-soft text-ok border border-line rounded-lg transition font-medium"
                          title="Ссылка подписки и QR-код для Incy"
                        >
                          <Link2 className="w-3.5 h-3.5" />
                          <span>Подписка</span>
                        </button>

                        {/* Edit Node Access */}
                        <button
                          onClick={() => onEditSubscriber(sub)}
                          title="Настроить доступ к серверам"
                          className="p-1.5 text-muted hover:text-info hover:bg-soft rounded-lg transition border border-line"
                        >
                          <Settings className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleResetTraffic(sub)}
                          title="Обнулить трафик"
                          className="p-1.5 text-muted hover:text-ok hover:bg-soft rounded-lg transition border border-line"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </button>

                        {/* Toggle */}
                        <button
                          onClick={() => handleToggle(sub)}
                          title={sub.enabled ? 'Отключить пользователя' : 'Включить пользователя'}
                          className={`p-1.5 rounded-lg transition ${
                            sub.enabled
                              ? 'text-muted hover:text-warn hover:bg-soft'
                              : 'text-warn hover:text-ok hover:bg-soft'
                          }`}
                        >
                          <Power className="w-4 h-4" />
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => handleDelete(sub)}
                          title="Удалить пользователя"
                          className="p-1.5 text-muted hover:text-bad hover:bg-soft rounded-lg transition border border-line"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
