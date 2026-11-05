import React, { useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';
import { copyToClipboard } from '../../utils';
import { ModalShell } from '../ui/Modal';
import { inputClass } from './shared';

export const TokenModal: React.FC<{ connectString: string; onClose: () => void }> = ({ connectString, onClose }) => {
  const [copied, setCopied] = useState(false);
  const insecure = connectString.startsWith('http:');
  return (
    <ModalShell label="Токен партнёра" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-lg shadow-pop p-6 space-y-4">
        <h2 className="text-base font-semibold text-ink flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-warn" />
          <span>Строка подключения для партнёра</span>
        </h2>
        <p className="text-xs text-muted">
          Передайте её партнёру по защищённому каналу. Он вставит её в своей панели: «Партнёры» → «Подключить панель партнёра».
          <strong className="text-warn"> Токен показывается только один раз</strong> — при утере перевыпустите его.
        </p>
        <textarea readOnly value={connectString} rows={3} className={`${inputClass} font-mono text-xs select-all`} />
        {insecure && (
          <p className="text-xs text-bad bg-bad-soft border border-line rounded-xl p-3">
            Панель открыта по HTTP: партнёр не сможет подключиться, пока вы не включите HTTPS (раздел «Безопасность») или не укажете
            публичный https-адрес в настройках панели.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={async () => {
              if (await copyToClipboard(connectString)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            }}
            className="flex items-center gap-2 bg-brand hover:bg-brand text-on-accent text-sm font-bold px-4 py-2 rounded-lg btn-press hover:text-on-accent"
          >
            <Copy className="w-4 h-4" />
            <span>{copied ? 'Скопировано' : 'Копировать'}</span>
          </button>
          <button onClick={onClose} className="px-4 py-2 bg-soft hover:bg-soft-2 text-ink rounded-xl text-sm border border-line">
            Готово
          </button>
        </div>
      </div>
    </ModalShell>
  );
};
