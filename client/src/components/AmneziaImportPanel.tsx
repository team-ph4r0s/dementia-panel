import React, { useState } from 'react';
import { Loader2, Download, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { api } from '../api';
import type { AmneziaImportResult } from '../types';

const STATUS_VIEW: Record<AmneziaImportResult['status'], { label: string; className: string; icon: React.ReactNode }> = {
  adopted: { label: 'Подключён без переустановки', className: 'text-ok', icon: <CheckCircle2 className="w-4 h-4 text-ok" /> },
  needs_install: { label: 'Добавлен, требуется установка', className: 'text-warn', icon: <AlertTriangle className="w-4 h-4 text-warn" /> },
  ssh_error: { label: 'Добавлен, нет SSH-доступа', className: 'text-warn', icon: <AlertTriangle className="w-4 h-4 text-warn" /> },
  exists: { label: 'Уже есть в панели', className: 'text-muted', icon: <AlertTriangle className="w-4 h-4 text-faint" /> },
  invalid: { label: 'Ключ не подходит', className: 'text-bad', icon: <XCircle className="w-4 h-4 text-bad" /> },
};

/**
 * Перенос серверов из AmneziaVPN по ключам «Поделиться → Полный доступ» (vpn://…)
 */
export const AmneziaImportPanel: React.FC<{ onImported: () => void; onClose: () => void }> = ({ onImported, onClose }) => {
  const [keys, setKeys] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AmneziaImportResult[] | null>(null);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.importAmneziaKeys(keys);
      setResults(res.results);
      setKeys('');
      onImported();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (results) {
    return (
      <div className="p-6 space-y-4 overflow-y-auto">
        <div className="space-y-2">
          {results.map((r, i) => {
            const view = STATUS_VIEW[r.status];
            return (
              <div key={i} className="p-3 bg-paper border border-line rounded-xl text-xs space-y-1">
                <div className="flex items-center gap-2">
                  {view.icon}
                  <span className="font-medium text-ink">{r.name || r.key}</span>
                  <span className={view.className}>{view.label}</span>
                </div>
                <p className="text-muted">{r.message}</p>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-faint">
          Клиенты, созданные в AmneziaVPN, продолжают работать и видны в панели с пометкой «импорт», но их конфигурации панель выдать не может.
          Новых клиентов создавайте в панели. Не меняйте клиентов этих серверов в приложении AmneziaVPN — панель перезапишет конфигурацию.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setResults(null)} className="px-4 py-2 text-sm text-muted hover:text-ink">
            Импортировать ещё
          </button>
          <button type="button" onClick={onClose} className="px-4 py-2 bg-soft hover:bg-soft-2 text-ink rounded-xl text-sm border border-line">
            Готово
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleImport} className="p-6 space-y-4 overflow-y-auto">
      {error && <div className="p-3 bg-bad-soft border border-line rounded-xl text-bad text-sm">{error}</div>}
      <div className="p-3 bg-paper border border-line rounded-xl text-xs text-muted space-y-1">
        <p>
          В приложении AmneziaVPN откройте сервер → <strong className="text-ink">«Поделиться»</strong> →{' '}
          <strong className="text-ink">«Полный доступ»</strong> и скопируйте ключ <code>vpn://…</code>.
        </p>
        <p>
          Панель подключится к серверу по SSH из ключа и заберёт работающий AmneziaWG вместе с ключами, параметрами и клиентами — переустанавливать
          ничего не нужно. Можно вставить несколько ключей, по одному на строку.
        </p>
      </div>
      <textarea
        required
        rows={6}
        value={keys}
        onChange={(e) => setKeys(e.target.value)}
        placeholder="vpn://AAAB..."
        className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-brand transition font-mono text-xs"
      />
      <p className="text-xs text-warn">
        Ключ полного доступа содержит пароль или SSH-ключ сервера. В панели он хранится зашифрованным, сам ключ не сохраняется.
      </p>
      <div className="flex items-center justify-end gap-3">
        <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-ink transition">
          Отмена
        </button>
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-sm px-5 py-2 rounded-lg transition btn-press hover:text-on-accent"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          <span>{loading ? 'Подключение к серверам...' : 'Импортировать'}</span>
        </button>
      </div>
    </form>
  );
};
