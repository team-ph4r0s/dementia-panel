import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowUpCircle, Loader2, CheckCircle2, AlertTriangle, ExternalLink, RotateCcw, Terminal } from 'lucide-react';
import type { PanelUpdateStatus, VersionInfo } from '../types';
import { api } from '../api';
import { ModalShell } from './ui/Modal';

interface PanelUpdateModalProps {
  info: VersionInfo;
  onClose: () => void;
}

/** Как часто спрашивать состояние, пока идёт обновление */
const POLL_MS = 3000;
const INSTALL_COMMAND = 'curl -sSL https://raw.githubusercontent.com/team-ph4r0s/dementia-panel/main/install.sh | sudo bash';

/**
 * Обновление панели до последнего релиза прямо из интерфейса. Обновление выполняет сервер (install.sh в отдельной службе
 * systemd): панель перезапускается, поэтому на время сборки запросы к ней не проходят — это ожидаемо.
 */
export const PanelUpdateModal: React.FC<PanelUpdateModalProps> = ({ info, onClose }) => {
  const [status, setStatus] = useState<PanelUpdateStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Панель не отвечает: идёт сборка или перезапуск службы
  const [restarting, setRestarting] = useState(false);
  const [watching, setWatching] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.getPanelUpdate();
      setStatus(next);
      setLoadError(null);
      setRestarting(false);
      return next;
    } catch (err: any) {
      if (watching) setRestarting(true);
      else setLoadError(err.message || 'Не удалось получить состояние обновления');
      return null;
    }
  }, [watching]);

  useEffect(() => {
    load().then((s) => s?.state === 'running' && setWatching(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(async () => {
      const next = await load();
      if (next && next.state !== 'running') setWatching(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [watching, load]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log]);

  const done = status?.state === 'success' && !watching && status.to === info.latest && status.to === status.current;
  // Новая версия интерфейса: страницу нужно перезагрузить
  const reloadNeeded = done && status.current !== info.current;
  useEffect(() => {
    if (!reloadNeeded) return;
    const timer = setTimeout(() => window.location.reload(), 4000);
    return () => clearTimeout(timer);
  }, [reloadNeeded]);

  const start = async () => {
    if (!info.latest) return;
    setStarting(true);
    setLoadError(null);
    try {
      setStatus(await api.startPanelUpdate(info.latest));
      setWatching(true);
      setConfirm(false);
    } catch (err: any) {
      setLoadError(err.message || 'Не удалось запустить обновление');
      load();
    } finally {
      setStarting(false);
    }
  };

  const running = watching || status?.state === 'running';
  const canClose = !running;
  const showResult = status && !running && status.state !== 'idle' && (status.to === info.latest || status.state !== 'success');

  return createPortal(
    <ModalShell label="Обновление панели" onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-xl shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-card">
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="w-5 h-5 text-ok" />
            <h2 className="text-base font-semibold text-ink">Обновление панели</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            disabled={!canClose}
            title={canClose ? 'Закрыть' : 'Дождитесь окончания обновления'}
            className="text-muted hover:text-ink transition p-1 rounded-lg hover:bg-soft disabled:opacity-30 disabled:hover:bg-transparent border border-line"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          <div className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-paper border border-line">
            <div>
              <div className="text-xs text-faint">Установлена</div>
              <div className="font-mono text-sm text-ink">{status?.current ?? info.current}</div>
            </div>
            <div className="text-faint">→</div>
            <div className="text-right">
              <div className="text-xs text-faint">Последний релиз</div>
              <div className="font-mono text-sm text-ok">{info.latest ?? '—'}</div>
            </div>
          </div>

          {info.latest_url && (
            <a
              href={info.latest_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-ok hover:text-ok"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Что нового в {info.latest}
            </a>
          )}

          {loadError && (
            <div className="flex gap-2 p-3 rounded-xl bg-bad-soft border border-line text-xs text-bad">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{loadError}</span>
            </div>
          )}

          {running && (
            <div className="flex gap-3 p-4 rounded-2xl bg-ok-soft border border-line">
              <Loader2 className="w-5 h-5 text-ok animate-spin shrink-0" />
              <div className="text-xs text-ink space-y-1">
                <div className="font-medium text-ink">
                  {restarting ? 'Панель перезапускается…' : `Обновление до ${status?.to ?? info.latest}…`}
                </div>
                <div className="text-muted">
                  Обычно занимает 1–3 минуты: скачивание релиза, резервная копия БД, сборка, перезапуск службы. Пока панель
                  перезапускается, она не отвечает — не закрывайте страницу.
                </div>
              </div>
            </div>
          )}

          {done && (
            <div className="flex gap-3 p-4 rounded-2xl bg-ok-soft border border-line">
              <CheckCircle2 className="w-5 h-5 text-ok shrink-0" />
              <div className="text-xs text-ink space-y-2">
                <div className="font-medium text-ink">Панель обновлена до {status.current}</div>
                <div>Данные, ноды, клиенты и подписки сохранены. Страница перезагрузится, чтобы загрузить новый интерфейс.</div>
                <button
                  onClick={() => window.location.reload()}
                  className="px-3 py-1.5 rounded-lg bg-brand text-on-accent font-semibold hover:bg-brand transition btn-press hover:text-on-accent"
                >
                  Перезагрузить страницу
                </button>
              </div>
            </div>
          )}

          {showResult && !done && (
            <div className="flex gap-3 p-4 rounded-2xl bg-warn-soft border border-line">
              {status.state === 'rolled_back' ? (
                <RotateCcw className="w-5 h-5 text-warn shrink-0" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-warn shrink-0" />
              )}
              <div className="text-xs text-ink space-y-1">
                <div className="font-medium text-ink">
                  {status.state === 'rolled_back' ? 'Обновление отменено' : status.state === 'success' ? 'Последнее обновление' : 'Обновление не удалось'}
                </div>
                {status.message && <div>{status.message}</div>}
                {status.finished_at && <div className="text-faint">{new Date(status.finished_at).toLocaleString('ru-RU')}</div>}
              </div>
            </div>
          )}

          {status && !status.available && !running && (
            <div className="space-y-2 p-4 rounded-2xl bg-paper border border-line text-xs text-muted">
              <div className="flex items-center gap-2 text-ink font-medium">
                <Terminal className="w-4 h-4" />
                Обновление из панели недоступно
              </div>
              <div>{status.reason}</div>
              <div>Обновите панель из терминала сервера — повторный запуск установки сохраняет все данные:</div>
              <code className="block p-2 rounded-lg bg-black/70 border border-line text-xs text-ok break-all select-all">
                {INSTALL_COMMAND}
              </code>
            </div>
          )}

          {status?.log && (
            <details open={running || status.state === 'failed' || status.state === 'rolled_back'} className="group">
              <summary className="cursor-pointer text-xs text-muted hover:text-ink select-none">Журнал обновления</summary>
              <pre
                ref={logRef}
                className="mt-2 max-h-64 overflow-auto p-3 rounded-xl bg-black/70 border border-line text-xs leading-4 text-muted whitespace-pre-wrap break-all"
              >
                {status.log}
              </pre>
            </details>
          )}
        </div>

        {status?.available && info.update_available && info.latest && !running && !done && (
          <div className="px-6 py-4 border-t border-line bg-card space-y-3">
            {confirm ? (
              <>
                <div className="text-xs text-muted">
                  Панель будет недоступна 1–3 минуты. Логин, пароль, ноды, клиенты, подписки и настройки сохранятся; перед
                  обновлением делается резервная копия БД, а если новая версия не запустится — панель вернётся на {info.current}.
                  VPN у пользователей не прерывается: ноды работают независимо от панели.
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setConfirm(false)}
                    className="px-4 py-2 rounded-xl text-xs font-medium text-ink hover:text-ink hover:bg-soft transition border border-line"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={start}
                    disabled={starting}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-brand text-on-accent hover:bg-brand transition disabled:opacity-60 btn-press hover:text-on-accent"
                  >
                    {starting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Обновить сейчас
                  </button>
                </div>
              </>
            ) : (
              <div className="flex justify-end">
                <button
                  onClick={() => setConfirm(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-brand text-on-accent hover:bg-brand transition btn-press hover:text-on-accent"
                >
                  <ArrowUpCircle className="w-4 h-4" />
                  Обновить до {info.latest}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </ModalShell>,
    document.body
  );
};
