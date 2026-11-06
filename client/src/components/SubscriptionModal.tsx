import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { X, Link2, Copy, Check, QrCode, RefreshCw, Server as ServerIcon, Smartphone } from 'lucide-react';
import type { Subscriber } from '../types';
import { api } from '../api';
import { AwgClientsGuide } from './AwgClientsGuide';
import { copyToClipboard } from '../utils';
import { useFeedback } from './ui/feedback-context';
import { ModalShell } from './ui/Modal';

interface SubscriptionModalProps {
  isOpen: boolean;
  subscriber: Subscriber | null;
  onClose: () => void;
  onTokenReset: (updated: Subscriber) => void;
  /** Публичный адрес панели из настроек (если панель открыта через туннель/внутренний адрес) */
  publicUrl?: string | null;
}

export const SubscriptionModal: React.FC<SubscriptionModalProps> = ({
  isOpen,
  subscriber,
  onClose,
  onTokenReset,
  publicUrl,
}) => {
  const { toast, confirm } = useFeedback();
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<{ url: string; image: string } | null>(null);
  const [resetting, setResetting] = useState(false);

  const subUrl = subscriber ? api.getSubscriptionUrl(subscriber.token, publicUrl) : '';
  // QR относится к конкретной ссылке: после её смены старый код не показывается
  const qrCodeUrl = qr && qr.url === subUrl ? qr.image : null;

  useEffect(() => {
    if (!subUrl) return;

    QRCode.toDataURL(subUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 300,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((image) => setQr({ url: subUrl, image }))
      .catch(() => {});
  }, [subUrl]);

  if (!isOpen || !subscriber) return null;

  const handleCopy = async () => {
    if (await copyToClipboard(subUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast('Не удалось скопировать — выделите ссылку вручную', 'info');
    }
  };

  const handleResetToken = async () => {
    if (!(await confirm({ message: 'Сбросить ссылку подписки? Старая ссылка перестанет работать, а ключи пользователя будут перевыпущены — на всех устройствах нужно будет добавить новую подписку.', danger: true, confirmLabel: 'Сбросить' }))) return;
    setResetting(true);
    try {
      const res = await api.resetSubscriberToken(subscriber.id);
      onTokenReset({ ...subscriber, token: res.token });
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setResetting(false);
    }
  };

  return (
    <ModalShell label="Подписка пользователя" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-lg shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-card">
          <div className="flex items-center gap-2.5">
            <Link2 className="w-5 h-5 text-ok" />
            <div>
              <h2 className="text-base font-semibold text-ink">Подписка</h2>
              <p className="text-xs text-muted">Пользователь: {subscriber.name}</p>
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

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Active Nodes Summary */}
          <div>
            <label className="block text-xs font-medium text-muted mb-2">
              Доступные ноды ({subscriber.servers.length}):
            </label>
            <div className="flex flex-wrap gap-1.5">
              {subscriber.servers.length === 0 ? (
                <span className="text-xs text-warn bg-warn-soft px-2.5 py-1 rounded-lg border border-line">
                  Нет назначенных нод. Выберите серверы в настройках пользователя.
                </span>
              ) : (
                subscriber.servers.map((s) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-paper border border-line text-ink"
                  >
                    <ServerIcon className="w-3.5 h-3.5 text-ok" />
                    <span>{s.name}</span>
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Subscription URL Field */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-muted">
                Ссылка на подписку:
              </label>
              <button
                onClick={handleResetToken}
                disabled={resetting}
                className="text-xs text-faint hover:text-warn transition flex items-center gap-1"
                title="Сгенерировать новый секретный токен"
              >
                <RefreshCw className={`w-3 h-3 ${resetting ? 'animate-spin' : ''}`} />
                <span>Сбросить ссылку</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={subUrl}
                className="flex-1 bg-paper border border-line rounded-xl px-3.5 py-2.5 text-xs text-ink font-mono focus:outline-none select-all"
              />
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 bg-brand hover:bg-brand text-on-accent font-bold text-xs px-4 py-2.5 rounded-lg transition flex-shrink-0 btn-press hover:text-on-accent"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'Скопировано!' : 'Копировать'}</span>
              </button>
            </div>
          </div>

          {/* QR Code */}
          {qrCodeUrl && (
            <div className="flex flex-col items-center space-y-2 pt-1">
              <div className="p-3 bg-white rounded-2xl shadow-pop">
                <img
                  src={qrCodeUrl}
                  alt="Subscription QR Code"
                  className="w-52 h-52 object-contain rounded-lg"
                />
              </div>
              <p className="text-xs text-muted text-center flex items-center gap-1.5 pt-1">
                <QrCode className="w-3.5 h-3.5 text-ok" />
                <span>Отсканируйте камерой в приложении <strong>Incy</strong> (iOS / Android)</span>
              </p>
            </div>
          )}

          {/* Какие приложения принимают эту ссылку */}
          <div className="p-4 bg-paper border border-line rounded-2xl space-y-3 text-xs text-muted">
            <div className="flex items-center gap-2 text-ok font-semibold">
              <Smartphone className="w-4 h-4" />
              <span>В каком приложении открыть ссылку</span>
            </div>
            <p>При добавлении или удалении серверов в панели список в приложении обновится сам.</p>
            <AwgClientsGuide compact />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-line bg-card flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-soft hover:bg-soft-2 text-ink rounded-xl text-xs font-medium transition border border-line"
          >
            Закрыть
          </button>
        </div>
      </div>
    </ModalShell>
  );
};
