import React, { useState } from 'react';
import { Lock, AlertTriangle, Loader2 } from 'lucide-react';
import { api } from '../../api';
import type { SslStatus } from '../../types';
import type { BannerMessage } from './SecurityBanner';
import { HTTPS_SWITCH_NOTE, switchToHttps } from './https';

interface TabProps {
  sslStatus?: SslStatus | null;
  setMessage: (message: BannerMessage | null) => void;
  onReload: () => void;
}

export const HttpIssueTab: React.FC<TabProps> = ({ setMessage, onReload }) => {
  const [httpDomain, setHttpDomain] = useState('');
  const [httpEmail, setHttpEmail] = useState('');
  const [httpIssuing, setHttpIssuing] = useState(false);

  // Issue via HTTP-01
  const handleIssueHttp = async (e: React.FormEvent) => {
    e.preventDefault();
    setHttpIssuing(true);
    setMessage(null);
    try {
      await api.issueLetsEncryptHttp({
        domain: httpDomain.trim(),
        email: httpEmail.trim(),
      });
      setMessage({
        type: 'success',
        text: `🎉 Сертификат Let's Encrypt для ${httpDomain} выпущен, HTTPS включён, автопродление настроено.` + HTTPS_SWITCH_NOTE,
      });
      onReload();
      switchToHttps(httpDomain.trim());
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setHttpIssuing(false);
    }
  };

  return (
        <form onSubmit={handleIssueHttp} className="space-y-4 bg-paper p-5 rounded-2xl border border-line">
          <div className="p-3 bg-warn-soft border border-line rounded-xl text-warn text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>
              Для HTTP-01 проверки ваш домен должен быть уже направлен на IP сервера, а порт 80 должен быть открыт в фаерволе.
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Домен</label>
              <input
                type="text"
                required
                placeholder="panel.example.com"
                value={httpDomain}
                onChange={(e) => setHttpDomain(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Email</label>
              <input
                type="email"
                required
                placeholder="admin@example.com"
                value={httpEmail}
                onChange={(e) => setHttpEmail(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-brand"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={httpIssuing || !httpDomain.trim()}
            className="flex items-center gap-2 bg-brand hover:bg-brand disabled:opacity-50 text-on-accent font-bold text-xs px-5 py-2.5 rounded-lg transition btn-press hover:text-on-accent"
          >
            {httpIssuing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
            <span>Выпустить сертификат (HTTP-01)</span>
          </button>
        </form>
  );
};
