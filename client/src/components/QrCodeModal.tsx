import React, { useState } from 'react';
import { X, QrCode, Download, Copy, Check } from 'lucide-react';
import type { QrCodeData } from '../types';
import { api } from '../api';
import { copyToClipboard } from '../utils';
import { useFeedback } from './ui/feedback-context';
import { ModalShell } from './ui/Modal';

interface QrCodeModalProps {
  isOpen: boolean;
  clientId: number | null;
  qrData: QrCodeData | null;
  onClose: () => void;
}

export const QrCodeModal: React.FC<QrCodeModalProps> = ({
  isOpen,
  clientId,
  qrData,
  onClose,
}) => {
  const { toast } = useFeedback();
  const [copied, setCopied] = useState(false);

  if (!isOpen || !qrData || !clientId) return null;

  const handleCopy = async () => {
    if (await copyToClipboard(qrData.config)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast('Не удалось скопировать — выделите текст конфигурации вручную', 'info');
    }
  };

  const handleDownload = () => {
    api.downloadClientConfig(clientId, qrData.clientName).catch((err) => toast(err.message, 'error'));
  };

  return (
    <ModalShell label="Конфигурация клиента" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-md shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-card">
          <div className="flex items-center gap-2">
            <QrCode className="w-5 h-5 text-ok" />
            <div>
              <h2 className="text-base font-semibold text-ink">Конфигурация клиента</h2>
              <p className="text-xs text-muted">{qrData.clientName}</p>
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
        <div className="p-6 space-y-5 overflow-y-auto flex flex-col items-center">
          {/* QR Code Container */}
          <div className="p-3 bg-white rounded-2xl shadow-pop">
            <img
              src={qrData.qrcode}
              alt="AmneziaWG QR Code"
              className="w-64 h-64 object-contain rounded-lg"
            />
          </div>
          <p className="text-xs text-muted text-center">
            Отсканируйте камерой смартфона в приложении <span className="text-ok font-medium">AmneziaWG</span> (для Amnezia VPN импортируйте .conf файл)
          </p>

          {/* Config Preview */}
          <div className="w-full">
            <div className="flex items-center justify-between mb-1.5 text-xs text-muted">
              <span>Содержимое .conf</span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-ok hover:text-ok transition"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Скопировано!' : 'Копировать'}</span>
              </button>
            </div>
            <pre className="w-full bg-paper border border-line rounded-xl p-3 font-mono text-xs text-ink max-h-36 overflow-y-auto leading-relaxed whitespace-pre select-all">
              {qrData.config}
            </pre>
          </div>

          {/* Download Action */}
          <div className="w-full flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={handleDownload}
              className="flex-1 flex items-center justify-center gap-2 bg-brand hover:bg-brand text-on-accent font-bold text-sm py-2.5 rounded-lg transition btn-press hover:text-on-accent"
            >
              <Download className="w-4 h-4" />
              <span>Скачать .conf файл</span>
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
};
