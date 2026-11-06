import React, { useState } from 'react';
import { X, UserPlus, Smartphone } from 'lucide-react';
import { api } from '../api';
import type { Client, NodeProtocol } from '../types';
import { ModalShell } from './ui/Modal';

interface AddClientModalProps {
  isOpen: boolean;
  serverId: number | null;
  serverName: string;
  protocol?: NodeProtocol;
  onClose: () => void;
  onClientAdded: (client: Client) => void;
}

export const AddClientModal: React.FC<AddClientModalProps> = ({
  isOpen,
  serverId,
  serverName,
  protocol = 'awg',
  onClose,
  onClientAdded,
}) => {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !serverId) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setError(null);
    setLoading(true);

    try {
      const client = await api.createClient(serverId, name.trim());
      onClientAdded(client);
      setName('');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Ошибка создания клиента');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell label="Новый клиент" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-md shadow-pop overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-card">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-ok" />
            <div>
              <h2 className="text-base font-semibold text-ink">Новый клиент {protocol === 'vless' ? 'VLESS' : 'AmneziaWG'}</h2>
              <p className="text-xs text-muted">{serverName}</p>
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
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-bad-soft border border-line rounded-xl text-bad text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Имя клиента / Устройства
            </label>
            <div className="relative">
              <input
                type="text"
                required
                autoFocus
                placeholder="например: iPhone-Alex, Home-PC"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl pl-9 pr-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition text-sm"
              />
              <Smartphone className="w-4 h-4 text-faint absolute left-3 top-2.5" />
            </div>
            <p className="text-xs text-faint mt-2">
              Ключи Curve25519 и свободный IP-адрес из подсети сервера будут назначены автоматически.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3">
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
              className="bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2 rounded-lg transition btn-press hover:text-on-accent"
            >
              {loading ? 'Создание...' : 'Создать клиента'}
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
};
