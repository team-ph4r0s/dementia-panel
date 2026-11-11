/**
 * Отличает клик/тап по городу от жеста: перетаскивания, щипка, отмены. Чистая логика без DOM — проверяется тестом.
 * Клик — один основной указатель (левая кнопка мыши или палец), отпущенный, не сдвинувшись дальше порога.
 */
export interface TapDetector {
  down(id: number, x: number, y: number, button: number): void;
  move(id: number, x: number, y: number): void;
  /** true — это был клик */
  up(id: number, x: number, y: number): boolean;
  cancel(id: number): void;
}

export function createTapDetector(threshold = 6): TapDetector {
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture = false;
  const move = (id: number, x: number, y: number) => {
    const p = pointers.get(id);
    if (p && Math.hypot(x - p.x, y - p.y) >= threshold) gesture = true;
  };
  return {
    down(id, x, y, button) {
      // Новый жест начинается, когда предыдущий полностью завершён; второй палец или не левая кнопка — уже не клик
      if (pointers.size === 0) gesture = false;
      else gesture = true;
      if (button !== 0) gesture = true;
      pointers.set(id, { x, y });
    },
    move,
    up(id, x, y) {
      if (!pointers.has(id)) return false;
      move(id, x, y);
      pointers.delete(id);
      return pointers.size === 0 && !gesture;
    },
    cancel(id) {
      pointers.delete(id);
      gesture = true;
    },
  };
}
