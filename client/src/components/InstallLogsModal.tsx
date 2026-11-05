import React, { useEffect, useRef, useState } from 'react';
import { Terminal, CheckCircle2, AlertCircle, X, Loader2 } from 'lucide-react';
import type { Server } from '../types';
import { getToken } from '../api';
import { ModalShell } from './ui/Modal';

interface InstallLogsModalProps {
  isOpen: boolean;
  server: Server | null;
  onClose: () => void;
  onFinished: () => void;
}

export const InstallLogsModal: React.FC<InstallLogsModalProps> = ({
  isOpen,
  server,
  onClose,
  onFinished,
}) => {
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<'connecting' | 'running' | 'success' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    if (!isOpen || !server) return;

    void Promise.resolve().then(() => {
      setLogs([]);
      setStatus('connecting');
      setErrorMessage(null);
    });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    let finished = false;

    // Токен передаётся первым сообщением, а не в URL
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_ok') {
          setStatus('running');
          ws.send(JSON.stringify({ type: 'start_install', serverId: server.id }));
        } else if (msg.type === 'log') {
          setLogs((prev) => [...prev, msg.data]);
        } else if (msg.type === 'install_finished') {
          finished = true;
          if (msg.result?.success) {
            setStatus('success');
            onFinishedRef.current();
          } else {
            setStatus('error');
            setErrorMessage(msg.result?.error || 'Произошла ошибка при установке');
            onFinishedRef.current();
          }
        } else if (msg.type === 'error') {
          finished = true;
          setStatus('error');
          setErrorMessage(msg.message);
          onFinishedRef.current();
        }
      } catch {
        setLogs((prev) => [...prev, event.data]);
      }
    };

    ws.onerror = () => {
      if (finished) return;
      setStatus('error');
      setErrorMessage('Не удалось установить WebSocket соединение с панелью');
    };

    ws.onclose = () => {
      if (finished) return;
      finished = true;
      setStatus('error');
      setErrorMessage('Соединение с панелью прервано. Установка могла продолжиться на сервере — проверьте его статус через минуту.');
      onFinishedRef.current();
    };

    return () => {
      finished = true;
      ws.close();
    };
  }, [isOpen, server]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  if (!isOpen || !server) return null;

  return (
    <ModalShell label="Установка AmneziaWG" onClose={onClose}>
      <div className="bg-paper border border-line rounded-2xl w-full max-w-3xl shadow-pop flex flex-col h-[75vh] overflow-hidden">
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-line bg-card">
          <div className="flex items-center gap-2.5">
            <Terminal className="w-5 h-5 text-ok" />
            <div>
              <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                <span>Установка AmneziaWG на {server.name}</span>
                <span className="text-faint font-mono text-xs">({server.host})</span>
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {status === 'running' && (
              <div className="flex items-center gap-2 text-xs text-warn bg-warn-soft px-2.5 py-1 rounded-full border border-line">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Установка...</span>
              </div>
            )}
            {status === 'success' && (
              <div className="flex items-center gap-1.5 text-xs text-ok bg-ok-soft px-2.5 py-1 rounded-full border border-line">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Успешно завершено</span>
              </div>
            )}
            {status === 'error' && (
              <div className="flex items-center gap-1.5 text-xs text-bad bg-bad-soft px-2.5 py-1 rounded-full border border-line">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>Ошибка</span>
              </div>
            )}

            <button
              onClick={onClose}
              aria-label="Закрыть"
              className="text-muted hover:text-ink transition p-1 rounded-lg hover:bg-soft border border-line"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Terminal Console */}
        <div
          ref={logContainerRef}
          className="flex-1 p-5 font-mono text-xs text-ink overflow-y-auto bg-black/70 space-y-1 select-text leading-relaxed whitespace-pre-wrap"
        >
          {logs.length === 0 && status === 'connecting' && (
            <div className="text-faint italic">Подключение к удаленному серверу по SSH...</div>
          )}

          {logs.map((log, index) => {
            const isError = log.toLowerCase().includes('ошибка') || log.toLowerCase().includes('error');
            const isSuccess = log.includes('УСПЕХ') || log.includes('готово') || log.includes('🎉');
            const isHeader = log.includes('[') && log.includes(']');

            return (
              <div
                key={index}
                className={
                  isError
                    ? 'text-bad'
                    : isSuccess
                    ? 'text-ok font-semibold'
                    : isHeader
                    ? 'text-info font-medium'
                    : 'text-ink'
                }
              >
                {log}
              </div>
            );
          })}

          {errorMessage && (
            <div className="text-bad bg-bad-soft border border-line p-3 rounded-lg my-2">
              {errorMessage}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-line bg-card flex items-center justify-between text-xs text-faint">
          <span>Поддерживаемые ОС: Ubuntu 20.04+, Debian 11+, AlmaLinux 9+</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-soft hover:bg-soft-2 text-ink rounded-lg transition font-medium border border-line"
          >
            Закрыть
          </button>
        </div>
      </div>
    </ModalShell>
  );
};
