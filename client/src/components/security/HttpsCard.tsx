import React, { useState } from 'react';
import { Lock, Cloud, Globe, FileText, Server, Power } from 'lucide-react';
import type { SslStatus } from '../../types';
import { HTTPS_SWITCH_NOTE, switchToHttps } from './https';
import { CloudflareTab } from './CloudflareTab';
import { HttpIssueTab } from './HttpIssueTab';
import { IpCertificateTab } from './IpCertificateTab';
import { CustomCertificateTab } from './CustomCertificateTab';
import { api } from '../../api';
import { SecurityBanner, type BannerMessage } from './SecurityBanner';

export const HttpsCard: React.FC<{
  sslStatus: SslStatus | null;
  onStatusChange: (status: SslStatus) => void;
  onReload: () => void;
}> = ({ sslStatus, onStatusChange, onReload }) => {
  // SSL Form state
  const [sslTab, setSslTab] = useState<'cf' | 'http' | 'ip' | 'custom'>('cf');

  // Сообщение под заголовком
  const [message, setMessage] = useState<BannerMessage | null>(null);

  // Toggle SSL
  const handleToggleSsl = async () => {
    if (!sslStatus) return;
    try {
      const targetState = !sslStatus.enabled;
      await api.toggleSsl(targetState);
      onStatusChange({ ...sslStatus, enabled: targetState });
      setMessage({
        type: 'success',
        text: targetState
          ? 'HTTPS активирован.' + HTTPS_SWITCH_NOTE
          : 'HTTPS отключен. Панель работает по обычному HTTP.',
      });
      if (targetState) switchToHttps(sslStatus.domain);
      else if (window.location.protocol === 'https:') {
        setTimeout(() => {
          window.location.href = `http://${window.location.host}${window.location.pathname}`;
        }, 2000);
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  return (
    <>
      <SecurityBanner message={message} onClose={() => setMessage(null)} />

      <div className="bg-card border border-line rounded-2xl p-6 sm:p-8 shadow-pop space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-line">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-ok-soft border border-line flex items-center justify-center">
              <Lock className="w-5 h-5 text-ok" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink tracking-wide">Настройка HTTPS (SSL)</h2>
              <p className="text-xs text-muted">
                Защита панели шифрованием, автовыпуск Let's Encrypt через Cloudflare DNS или сертификат на IP
              </p>
              {sslStatus?.cfTokenSaved && <p className="text-xs text-ok mt-1">API токен Cloudflare уже сохранён</p>}
            </div>
          </div>

          {/* SSL Status Badge and Toggle */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  sslStatus?.enabled ? 'bg-ok' : 'bg-faint'
                }`}
              />
              <span className="text-xs font-semibold text-ink">
                {sslStatus?.enabled ? 'HTTPS АКТИВЕН' : 'HTTP (НЕ ЗАЩИЩЕНО)'}
              </span>
            </div>

            <button
              onClick={handleToggleSsl}
              disabled={!sslStatus?.hasCert}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                sslStatus?.enabled
                  ? 'bg-soft text-ink hover:bg-soft-2'
                  : 'bg-brand hover:bg-brand text-on-accent disabled:opacity-40'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              <span>{sslStatus?.enabled ? 'Выключить HTTPS' : 'Включить HTTPS'}</span>
            </button>
          </div>
        </div>

        {/* Current Certificate Details */}
        {sslStatus?.hasCert && (
          <div className="p-4 bg-paper border border-line rounded-2xl flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="space-y-1">
              <span className="text-faint font-medium">Активный сертификат:</span>
              <div className="flex items-center gap-2 font-mono text-ink">
                <Globe className="w-3.5 h-3.5 text-ok" />
                <span>{sslStatus.domain || 'Сертификат установлен'}</span>
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-faint font-medium">Режим выпуска:</span>
              <div className="text-ink font-semibold uppercase">
                {sslStatus.mode === 'letsencrypt_cf'
                  ? 'Let’s Encrypt (Cloudflare DNS)'
                  : sslStatus.mode === 'letsencrypt_http'
                  ? 'Let’s Encrypt (HTTP-01)'
                  : sslStatus.mode === 'selfsigned_ip'
                  ? 'IP SAN Certificate'
                  : 'Пользовательский PEM'}
              </div>
            </div>

            {sslStatus.expiresAt && (
              <div className="space-y-1">
                <span className="text-faint font-medium">Действителен до:</span>
                <div className="text-ok font-mono">
                  {new Date(sslStatus.expiresAt).toLocaleDateString()}
                </div>
              </div>
            )}
          </div>
        )}

        {/* SSL Method Tabs */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 border-b border-line pb-2 overflow-x-auto">
            <button
              onClick={() => setSslTab('cf')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                sslTab === 'cf' ? 'bg-soft text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <Cloud className="w-4 h-4 text-warn" />
              <span>Cloudflare API (Рекомендуется)</span>
            </button>

            <button
              onClick={() => setSslTab('ip')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                sslTab === 'ip' ? 'bg-soft text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <Server className="w-4 h-4 text-info" />
              <span>Сертификат на IP-адрес</span>
            </button>

            <button
              onClick={() => setSslTab('http')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                sslTab === 'http' ? 'bg-soft text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <Globe className="w-4 h-4 text-ok" />
              <span>Let's Encrypt (HTTP-01)</span>
            </button>

            <button
              onClick={() => setSslTab('custom')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                sslTab === 'custom' ? 'bg-soft text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <FileText className="w-4 h-4 text-accent" />
              <span>Свой сертификат (PEM)</span>
            </button>
          </div>

          {sslTab === 'cf' && <CloudflareTab sslStatus={sslStatus} setMessage={setMessage} onReload={onReload} />}
          {sslTab === 'ip' && <IpCertificateTab sslStatus={sslStatus} setMessage={setMessage} onReload={onReload} />}
          {sslTab === 'http' && <HttpIssueTab sslStatus={sslStatus} setMessage={setMessage} onReload={onReload} />}
          {sslTab === 'custom' && <CustomCertificateTab sslStatus={sslStatus} setMessage={setMessage} onReload={onReload} />}
        </div>
      </div>

    </>
  );
};
