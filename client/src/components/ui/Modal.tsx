import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Каркас всех модальных окон: затемнение, role="dialog", Esc, возврат фокуса и ловушка Tab.
 * Внутри — обычная панель окна с прежней разметкой. Окно, открытое поверх другого (подтверждение), закрывается первым:
 * Esc и Tab обрабатывает только верхнее.
 */
const stack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalShellProps {
  /** Короткое название окна для скринридеров */
  label: string;
  onClose: () => void;
  /** Подтверждения поверх обычных окон */
  elevated?: boolean;
  /**
   * `drawer` — боковая панель слева на всю высоту (меню разделов на телефоне). Только у неё тап по затемнению закрывает окно:
   * в меню нечего потерять, а у обычных окон с формами закрытие по фону не принято (AGENTS.md).
   */
  variant?: 'center' | 'drawer';
  children: React.ReactNode;
}

export const ModalShell: React.FC<ModalShellProps> = ({ label, onClose, elevated = false, variant = 'center', children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const id = Symbol('modal');
    stack.push(id);
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Фокус — на первое поле/кнопку окна; если там нет ничего, на сам диалог
    if (root && !root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? root.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? root).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      const index = stack.indexOf(id);
      if (index >= 0) stack.splice(index, 1);
      if (stack.length === 0) document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  // Через портал в body: предок с backdrop-filter/transform (например, шапка) превращает position: fixed в «относительно предка»
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onClick={variant === 'drawer' ? (e) => { if (e.target === e.currentTarget) onCloseRef.current(); } : undefined}
      className={`fixed inset-0 ${elevated ? 'z-[60]' : 'z-50'} flex ${variant === 'drawer' ? 'items-stretch justify-start' : 'items-center justify-center p-4'} bg-black/70 animate-in fade-in duration-200 outline-none`}
    >
      {children}
    </div>,
    document.body
  );
};
