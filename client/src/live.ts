import { useEffect, useRef, useState } from 'react';
import { getToken } from './api';

const MIN_DELAY = 1000;
const MAX_DELAY = 30_000;

/**
 * Живые обновления: держит WebSocket к панели и вызывает onChange, когда сервер сообщает {type: 'changed'}. Возвращает true,
 * пока соединение авторизовано. Обрыв связи — повтор с нарастающей паузой (1 с … 30 с); код 4401 (сессия недействительна, гостю
 * сокет не нужен) повторов не вызывает — дальше работает обычный опрос. При возвращении на вкладку данные обновляются сразу.
 */
export function useLiveUpdates(enabled: boolean, onChange: (scopes?: string[]) => void): boolean {
  const [connected, setConnected] = useState(false);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') return;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let delay = MIN_DELAY;
    let stopped = false;

    const open = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      ws = socket;
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: getToken() }));
      socket.onmessage = (event) => {
        let msg: { type?: string; scopes?: unknown };
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.type === 'auth_ok') {
          delay = MIN_DELAY;
          setConnected(true);
          // Пока сокет не был подключён, изменения могли пройти мимо
          onChangeRef.current(undefined);
        } else if (msg.type === 'changed') {
          const scopes = Array.isArray(msg.scopes) ? msg.scopes.filter((s): s is string => typeof s === 'string') : undefined;
          onChangeRef.current(scopes?.length ? scopes : undefined);
        }
      };
      socket.onclose = (event) => {
        setConnected(false);
        ws = null;
        if (stopped || event.code === 4401) return;
        retry = setTimeout(open, delay);
        delay = Math.min(MAX_DELAY, delay * 2);
      };
      socket.onerror = () => socket.close();
    };

    const onVisible = () => {
      if (!document.hidden) onChangeRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    open();

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (retry) clearTimeout(retry);
      ws?.close();
      setConnected(false);
    };
  }, [enabled]);

  return connected;
}
