import React, { useState } from 'react';
import { Smartphone, Share, EllipsisVertical, SquarePlus, X } from 'lucide-react';
import { useInstallApp } from '../pwa';
import { ModalShell } from './ui/Modal';

const Step: React.FC<{ n: number; children: React.ReactNode }> = ({ n, children }) => (
  <li className="flex items-start gap-3">
    <span className="w-6 h-6 shrink-0 rounded-full bg-brand-soft text-brand text-xs font-bold flex items-center justify-center">{n}</span>
    <span className="text-sm text-ink pt-0.5">{children}</span>
  </li>
);

/**
 * Кнопка «Установить приложение» в шапке. Chrome/Edge — системный диалог установки; iOS и Android без такого диалога — окно с шагами
 * (в iOS установки из браузера кнопкой нет, только «Поделиться → На экран „Домой“»). Скрыта, когда панель уже открыта как приложение.
 */
/** wide — пункт бокового меню на телефоне: во всю ширину и с подписью */
export const InstallAppButton: React.FC<{ wide?: boolean }> = ({ wide = false }) => {
  const app = useInstallApp();
  const [guideOpen, setGuideOpen] = useState(false);
  if (!app.visible) return null;

  const onClick = async () => {
    if (app.canPrompt) {
      await app.install();
    } else {
      setGuideOpen(true);
    }
  };

  return (
    <>
      <button
        onClick={onClick}
        title="Установить панель как приложение"
        aria-label="Установить панель как приложение"
        className={wide
          ? 'w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-ink hover:bg-soft border border-line transition'
          : 'flex items-center gap-1.5 px-3 py-2 text-ink bg-card border border-line rounded-lg hover:bg-soft transition'}
      >
        <Smartphone className="w-4 h-4 text-brand" />
        <span className={wide ? '' : 'hidden lg:inline text-xs font-medium'}>{wide ? 'Установить как приложение' : 'Приложение'}</span>
      </button>

      {guideOpen && (
        <ModalShell label="Установка панели как приложения" onClose={() => setGuideOpen(false)}>
          <div className="bg-card border border-line rounded-2xl w-full max-w-md shadow-pop overflow-hidden max-h-[90dvh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-line">
              <div className="flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-brand" />
                <h2 className="text-base font-semibold text-ink">Панель как приложение</h2>
              </div>
              <button onClick={() => setGuideOpen(false)} aria-label="Закрыть" className="text-muted hover:text-ink transition p-1 rounded-lg hover:bg-soft border border-line">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 overflow-y-auto">
              {app.platform === 'ios' ? (
                <ol className="space-y-3">
                  <Step n={1}>Откройте панель в <strong>Safari</strong>.</Step>
                  <Step n={2}>
                    Нажмите <Share className="inline w-4 h-4 text-brand -mt-0.5" /> <strong>«Поделиться»</strong> в панели браузера.
                  </Step>
                  <Step n={3}>
                    Выберите <SquarePlus className="inline w-4 h-4 text-brand -mt-0.5" /> <strong>«На экран „Домой“»</strong> и нажмите «Добавить».
                  </Step>
                </ol>
              ) : (
                <ol className="space-y-3">
                  <Step n={1}>
                    Откройте меню браузера <EllipsisVertical className="inline w-4 h-4 text-brand -mt-0.5" /> (три точки).
                  </Step>
                  <Step n={2}>
                    Выберите <strong>«Установить приложение»</strong> (в некоторых браузерах — «Добавить на главный экран»).
                  </Step>
                </ol>
              )}

              {!app.secure && (
                <div className="bg-warn-soft border border-line rounded-xl p-3.5 text-xs text-warn space-y-1.5">
                  <p className="font-semibold">Панель открыта по HTTP</p>
                  <p>
                    {app.platform === 'ios'
                      ? 'Ярлык на домашнем экране добавится, но офлайн-оболочка и быстрый запуск не заработают.'
                      : 'Android-браузеры устанавливают приложения только по HTTPS: сейчас получится лишь ярлык сайта.'}{' '}
                    Включите HTTPS в разделе «Безопасность» — и панель можно будет установить полноценно.
                  </p>
                </div>
              )}

              <p className="text-xs text-muted">
                После установки панель откроется в отдельном окне без адресной строки, вход сохранится. Данные нод по-прежнему загружаются с вашей
                панели — без связи приложение покажет экран «Нет связи».
              </p>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
};
