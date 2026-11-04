import React, { useState } from 'react';
import { Lock, Cloud, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '../../api';
import type { SslStatus, CloudflareZone } from '../../types';
import type { BannerMessage } from './SecurityBanner';
import { HTTPS_SWITCH_NOTE, switchToHttps } from './https';

interface TabProps {
  sslStatus?: SslStatus | null;
  setMessage: (message: BannerMessage | null) => void;
  onReload: () => void;
}

export const CloudflareTab: React.FC<TabProps> = ({ sslStatus, setMessage, onReload }) => {
  const saved = Boolean(sslStatus?.cfTokenSaved);
  const [cfToken, setCfToken] = useState('');
  const [cfValid, setCfValid] = useState<boolean | null>(null);
  const [cfVerifying, setCfVerifying] = useState(false);
  const [cfZones, setCfZones] = useState<CloudflareZone[]>([]);
  const [cfDomain, setCfDomain] = useState(sslStatus?.domain || '');
  const [cfEmail, setCfEmail] = useState(sslStatus?.email || '');
  const [cfCreateARecord, setCfCreateARecord] = useState(true);
  const [cfIssuing, setCfIssuing] = useState(false);

  // Cloudflare token check
  const handleVerifyCfToken = async () => {
    if (!cfToken.trim() && !saved) return;
    setCfVerifying(true);
    setCfValid(null);
    try {
      const res = await api.verifyCloudflareToken(cfToken.trim());
      setCfValid(res.valid);
      if (res.valid) {
        const zones = await api.getCloudflareZones(cfToken.trim());
        setCfZones(zones);
        setMessage({ type: 'success', text: 'Токен Cloudflare подтвержден! Найдено зон: ' + zones.length });
      } else {
        setMessage({ type: 'error', text: res.message });
      }
    } catch (err: any) {
      setCfValid(false);
      setMessage({ type: 'error', text: err.message });
    } finally {
      setCfVerifying(false);
    }
  };

  // Issue via Cloudflare
  const handleIssueCf = async (e: React.FormEvent) => {
    e.preventDefault();
    setCfIssuing(true);
    setMessage(null);
    try {
      await api.issueLetsEncryptCf({
        domain: cfDomain.trim(),
        email: cfEmail.trim(),
        token: cfToken.trim(),
        createARecord: cfCreateARecord,
      });
      setCfToken('');
      setMessage({
        type: 'success',
        text: `🎉 Сертификат Let's Encrypt для ${cfDomain} выпущен, HTTPS включён, автопродление настроено.` + HTTPS_SWITCH_NOTE,
      });
      onReload();
      switchToHttps(cfDomain.trim());
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setCfIssuing(false);
    }
  };

  return (
        <form onSubmit={handleIssueCf} className="space-y-4 bg-paper p-5 rounded-2xl border border-line">
          <div className="flex items-start gap-2 text-xs text-muted">
            <Cloud className="w-4 h-4 text-warn flex-shrink-0 mt-0.5" />
            <span>
              Панель автоматически добавит временную запись DNS <code>_acme-challenge</code> через API Cloudflare и выпустит сертификат Let's Encrypt без необходимости открывать 80-й порт.
            </span>
          </div>

          {/* Cloudflare Token Input with Verify button */}
          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              API Токен Cloudflare (Zone:Read и DNS:Edit)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="password"
                required={!saved}
                aria-label="API токен Cloudflare для сертификата"
                autoComplete="new-password"
                placeholder={saved ? 'Сохранён — оставьте пустым для повторного использования' : 'Вставьте токен из Cloudflare Dashboard...'}
                value={cfToken}
                onChange={(e) => {
                  setCfToken(e.target.value);
                  setCfValid(null);
                }}
                className="flex-1 min-w-0 bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs font-mono focus:outline-none focus:border-brand"
              />
              <button
                type="button"
                onClick={handleVerifyCfToken}
                disabled={cfVerifying || (!cfToken.trim() && !saved)}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-soft hover:bg-soft-2 text-ink rounded-xl transition disabled:opacity-50 border border-line"
              >
                {cfVerifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 text-ok" />}
                <span>{cfValid ? 'Подтвержден' : 'Проверить'}</span>
              </button>
            </div>
            {saved && <p role="status" className="text-xs text-ok mt-2">Токен Cloudflare сохранён зашифрованным. Оставьте поле пустым, чтобы использовать его; новый токен заменит прежний после успешной операции.</p>}
          </div>

          {cfZones.length > 0 && (
            <div className="text-xs text-faint">
              Доступные домены в Cloudflare: {cfZones.map((z) => z.name).join(', ')}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">
                Доменное имя для панели
              </label>
              <input
                type="text"
                required
                placeholder="например: panel.example.com"
                value={cfDomain}
                onChange={(e) => setCfDomain(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-brand"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted mb-1">
                Email для уведомлений Let's Encrypt
              </label>
              <input
                type="email"
                required
                placeholder="admin@example.com"
                value={cfEmail}
                onChange={(e) => setCfEmail(e.target.value)}
                className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-brand"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="cfARecord"
              checked={cfCreateARecord}
              onChange={(e) => setCfCreateARecord(e.target.checked)}
              className="rounded border-line text-ok focus:ring-0"
            />
            <label htmlFor="cfARecord" className="text-xs text-ink cursor-pointer">
              Автоматически добавить или обновить A-запись в Cloudflare на IP-адрес этого сервера
            </label>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={cfIssuing || (!cfToken.trim() && !saved)}
              className="flex items-center gap-2 bg-brand disabled:opacity-50 text-on-accent font-bold text-xs px-5 py-2.5 rounded-full transition btn-press"
            >
              {cfIssuing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Выпуск сертификата (проверка DNS)...</span>
                </>
              ) : (
                <>
                  <Lock className="w-3.5 h-3.5" />
                  <span>Выпустить сертификат Let's Encrypt через Cloudflare</span>
                </>
              )}
            </button>
          </div>
        </form>
  );
};
