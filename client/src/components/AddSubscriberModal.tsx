import React, { useState, useEffect } from 'react';
import { X, UserPlus, Server as ServerIcon, CheckSquare, Square, Shield } from 'lucide-react';
import type { Server, Subscriber } from '../types';
import { api } from '../api';
import { GIB } from '../utils';
import { CountrySelect } from './CountrySelect';
import { ModalShell } from './ui/Modal';

function toDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

interface AddSubscriberModalProps {
  isOpen: boolean;
  servers: Server[];
  editingSubscriber: Subscriber | null;
  onClose: () => void;
  onSaved: (subscriber: Subscriber) => void;
}

export const AddSubscriberModal: React.FC<AddSubscriberModalProps> = ({
  isOpen,
  servers,
  editingSubscriber,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState('');
  const [selectedServerIds, setSelectedServerIds] = useState<number[]>([]);
  const [limitGb, setLimitGb] = useState('');
  const [expireDate, setExpireDate] = useState('');
  const [country, setCountry] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Форма заполняется только при открытии: периодический опрос серверов не должен затирать ввод
  useEffect(() => {
    if (!isOpen) return;
    if (editingSubscriber) {
      setName(editingSubscriber.name);
      setSelectedServerIds(editingSubscriber.server_ids || []);
      setLimitGb(editingSubscriber.traffic_limit ? String(+(editingSubscriber.traffic_limit / GIB).toFixed(2)) : '');
      setExpireDate(toDateInput(editingSubscriber.expire_at));
      setCountry(editingSubscriber.country ?? '');
    } else {
      setName('');
      // By default select all online servers
      setSelectedServerIds(servers.filter((s) => s.status === 'online').map((s) => s.id));
      setLimitGb('');
      setExpireDate('');
      setCountry('');
    }
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editingSubscriber?.id]);

  if (!isOpen) return null;

  const toggleServer = (serverId: number) => {
    setSelectedServerIds((prev) =>
      prev.includes(serverId) ? prev.filter((id) => id !== serverId) : [...prev, serverId]
    );
  };

  const selectAll = () => {
    setSelectedServerIds(servers.map((s) => s.id));
  };

  const deselectAll = () => {
    setSelectedServerIds([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const limit = limitGb.trim() ? Math.round(parseFloat(limitGb.replace(',', '.')) * GIB) : 0;
    if (!Number.isFinite(limit) || limit < 0) {
      setError('Лимит трафика должен быть положительным числом (ГБ)');
      return;
    }
    // Дата окончания — конец выбранного дня по местному времени
    const expireAt = expireDate ? new Date(`${expireDate}T23:59:59`).toISOString() : null;

    setError(null);
    setLoading(true);

    try {
      if (editingSubscriber) {
        const updated = await api.updateSubscriber(editingSubscriber.id, {
          name: name.trim(),
          server_ids: selectedServerIds,
          traffic_limit: limit,
          expire_at: expireAt,
          country: country || null,
        });
        onSaved(updated);
      } else {
        const created = await api.createSubscriber({
          name: name.trim(),
          server_ids: selectedServerIds,
          traffic_limit: limit,
          expire_at: expireAt,
          country: country || null,
        });
        onSaved(created);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Ошибка сохранения пользователя');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell label="Пользователь" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-lg shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-card">
          <div className="flex items-center gap-2.5">
            <UserPlus className="w-5 h-5 text-ok" />
            <div>
              <h2 className="text-base font-semibold text-ink">
                {editingSubscriber ? 'Редактировать пользователя' : 'Новый пользователь (Подписка)'}
              </h2>
              <p className="text-xs text-muted">
                {editingSubscriber ? editingSubscriber.name : 'Мультисерверная подписка AmneziaWG (Incy)'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-muted hover:text-ink transition p-1 rounded-lg hover:bg-soft border border-line"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto">
          {error && (
            <div className="p-3 bg-bad-soft border border-line rounded-xl text-bad text-xs">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">
              Имя пользователя / Клиента
            </label>
            <input
              type="text"
              required
              autoFocus
              placeholder="например: Иван, Alex-iOS, Client-01"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-paper border border-line rounded-xl px-3.5 py-2.5 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Лимит трафика, ГБ</label>
              <input
                type="number"
                min="0"
                step="0.1"
                placeholder="без лимита"
                value={limitGb}
                onChange={(e) => setLimitGb(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2.5 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Действует до</label>
              <input
                type="date"
                value={expireDate}
                onChange={(e) => setExpireDate(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2.5 text-ink focus:outline-none focus:border-brand transition text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Страна пользователя</label>
            <CountrySelect
              value={country}
              onChange={setCountry}
              emptyLabel="Не задана"
              className="w-full bg-paper border border-line rounded-xl px-3.5 py-2.5 text-ink focus:outline-none focus:border-brand transition text-sm"
            />
            <p className="text-xs text-faint mt-1">
              Если нода недоступна из этой страны, а у ноды есть мост в ней, подписка выдаст адрес моста (раздел «Мосты»).
            </p>
          </div>

          {/* Node Selection Checkboxes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-ink flex items-center gap-1.5">
                <ServerIcon className="w-3.5 h-3.5 text-ok" />
                <span>Доступные ноды (серверы):</span>
              </label>

              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-ok hover:text-ok transition"
                >
                  Выбрать все
                </button>
                <span className="text-faint">&bull;</span>
                <button
                  type="button"
                  onClick={deselectAll}
                  className="text-faint hover:text-muted transition"
                >
                  Снять все
                </button>
              </div>
            </div>

            {servers.length === 0 ? (
              <div className="p-4 bg-paper border border-dashed border-line rounded-2xl text-center text-xs text-faint">
                Нет добавленных серверов. Сначала добавьте хотя бы один сервер AmneziaWG.
              </div>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {servers.map((s) => {
                  const isChecked = selectedServerIds.includes(s.id);
                  const isOnline = s.status === 'online';

                  return (
                    <div
                      key={s.id}
                      onClick={() => toggleServer(s.id)}
                      className={`flex items-center justify-between p-3 rounded-2xl border cursor-pointer transition select-none ${
                        isChecked
                          ? 'bg-soft border-line text-ink'
                          : 'bg-paper border-line text-muted hover:bg-card'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {isChecked ? (
                          <CheckSquare className="w-4 h-4 text-ok flex-shrink-0" />
                        ) : (
                          <Square className="w-4 h-4 text-faint flex-shrink-0" />
                        )}
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-ink">{s.name}</span>
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                isOnline ? 'bg-ok' : 'bg-faint'
                              }`}
                            />
                          </div>
                          <p className="text-xs font-mono text-faint">
                            {s.host}:{s.awg_port}
                            {s.remote_panel_name && <span className="font-sans text-warn"> · партнёр: {s.remote_panel_name}</span>}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 text-xs font-mono text-faint">
                        <Shield className="w-3 h-3 text-ok" />
                        <span>AWG</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-faint mt-2">
              * Пользователь получит единую ссылку подписки. Все выбранные ноды появятся у него в Incy автоматически.
            </p>
          </div>

          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-line">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted hover:text-ink transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading}
              className="bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2.5 rounded-lg transition btn-press hover:text-on-accent"
            >
              {loading ? 'Сохранение...' : editingSubscriber ? 'Обновить доступ' : 'Создать подписку'}
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
};
