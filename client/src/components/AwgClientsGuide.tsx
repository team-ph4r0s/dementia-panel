import React, { useState } from 'react';
import { ExternalLink, RefreshCw, FileDown, Ban } from 'lucide-react';
import { AWG_CLIENTS, AWG_PLATFORMS, AWG_UNSUPPORTED } from '../awgClients';
import type { AwgPlatform } from '../awgClients';

/** Платформа по User-Agent браузера администратора — с неё удобнее начать */
function detectPlatform(): AwgPlatform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Mac OS X/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'windows';
}

/**
 * Какие приложения подключаются к нодам AmneziaWG и как: по ссылке подписки (серверы обновляются сами) или вручную
 * (.conf / QR отдельного клиента). Данные — client/src/awgClients.ts.
 */
export const AwgClientsGuide: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const [platform, setPlatform] = useState<AwgPlatform>(detectPlatform);
  const clients = AWG_CLIENTS.filter((c) => c.platforms.includes(platform));
  const groups = [
    { mode: 'subscription' as const, title: 'По ссылке подписки', hint: 'Серверы добавляются и обновляются сами', icon: RefreshCw },
    { mode: 'manual' as const, title: 'Вручную', hint: '.conf или QR-код клиента из списка клиентов ноды, без автообновления', icon: FileDown },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {AWG_PLATFORMS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPlatform(p.id)}
            className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold transition ${
              platform === p.id ? 'bg-brand text-on-accent' : 'bg-soft text-muted hover:text-ink hover:bg-soft-2'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="rounded-xl bg-paper border border-line p-3 text-xs space-y-1">
        <h3 className="font-semibold text-ink">Приложения для VLESS Reality</h3>
        <p className="text-muted">Android — v2rayNG или Hiddify. iOS — Streisand или Happ. Windows — v2rayN.</p>
        <p className="text-muted">Добавьте подписку или импортируйте ссылку vless:// либо QR-код клиента.</p>
      </div>

      {groups.map(({ mode, title, hint, icon: Icon }) => {
        const list = clients.filter((c) => c.mode === mode);
        return (
          <div key={mode} className="space-y-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <Icon className={`w-3.5 h-3.5 ${mode === 'subscription' ? 'text-ok' : 'text-info'}`} />
                {title}
              </span>
              {!compact && <span className="text-xs text-faint">{hint}</span>}
            </div>
            {list.length === 0 ? (
              <p className="text-xs text-warn bg-warn-soft rounded-xl px-3 py-2">
                Для этой платформы нет приложений, которые принимают подписку с AmneziaWG — только ручная настройка.
              </p>
            ) : (
              <div className={`grid gap-2 ${compact ? '' : 'sm:grid-cols-2'}`}>
                {list.map((c) => (
                  <div key={c.name} className="rounded-xl bg-paper border border-line p-3 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-ink hover:text-ok inline-flex items-center gap-1"
                      >
                        {c.name}
                        <ExternalLink className="w-3 h-3 text-faint" />
                      </a>
                      <span
                        className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
                          c.awg3.startsWith('да') ? 'bg-ok-soft text-ok' : c.awg3 === 'не указано' ? 'bg-soft text-faint' : 'bg-warn-soft text-warn'
                        }`}
                        title="Поддержка AmneziaWG 3.x: новые ноды панели устанавливаются с параметрами 3.x"
                      >
                        AWG 3.x: {c.awg3}
                      </span>
                    </div>
                    {c.link && <p className="text-muted">Ссылка: {c.link}</p>}
                    {c.note && !compact && <p className="text-faint">{c.note}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {!compact && (
        <div className="space-y-1.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Ban className="w-3.5 h-3.5 text-bad" />
            Не подходят
          </span>
          <div className="flex flex-wrap gap-1.5">
            {AWG_UNSUPPORTED.map((u) => (
              <span key={u.name} className="text-xs px-2.5 py-1 rounded-full bg-soft text-muted" title={u.reason}>
                <span className="text-ink">{u.name}</span> — {u.reason}
              </span>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-faint">
        Ноды на AmneziaWG 1.x подключаются в любом из этих приложений; для нод 3.x нужна поддержка 3.x. Клиенты mihomo узнаются по
        User-Agent и получают свой формат по основной ссылке. Список проверен в октябре 2026.
      </p>
    </div>
  );
};
