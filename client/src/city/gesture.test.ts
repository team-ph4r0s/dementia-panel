import { describe, expect, it } from 'vitest';
import { createTapDetector, isZoomWheel } from './gesture';

describe('isZoomWheel', () => {
  it('колесо приближает город только с Ctrl/⌘ или жестом трекпада, иначе прокручивает страницу', () => {
    expect(isZoomWheel({ ctrlKey: false, metaKey: false })).toBe(false);
    expect(isZoomWheel({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isZoomWheel({ ctrlKey: false, metaKey: true })).toBe(true);
  });
});

describe('createTapDetector', () => {
  it('нажатие и отпускание на месте — клик', () => {
    const tap = createTapDetector();
    tap.down(1, 10, 10, 0);
    expect(tap.up(1, 12, 11)).toBe(true);
  });

  it('перетаскивание, вернувшееся в исходную точку, — не клик', () => {
    const tap = createTapDetector();
    tap.down(1, 10, 10, 0);
    tap.move(1, 80, 10);
    expect(tap.up(1, 10, 10)).toBe(false);
  });

  it('щипок: последний неподвижный палец не выбирает и не снимает выбор', () => {
    const tap = createTapDetector();
    tap.down(1, 10, 10, 0);
    tap.down(2, 100, 100, 0);
    tap.move(2, 140, 140);
    expect(tap.up(2, 140, 140)).toBe(false);
    expect(tap.up(1, 10, 10)).toBe(false);
  });

  it('отмена жеста — не клик, следующий жест считается заново', () => {
    const tap = createTapDetector();
    tap.down(1, 10, 10, 0);
    tap.cancel(1);
    tap.down(1, 20, 20, 0);
    expect(tap.up(1, 20, 20)).toBe(true);
  });

  it('правая и средняя кнопки мыши не выбирают', () => {
    const tap = createTapDetector();
    tap.down(1, 10, 10, 2);
    expect(tap.up(1, 10, 10)).toBe(false);
    tap.down(1, 10, 10, 1);
    expect(tap.up(1, 10, 10)).toBe(false);
  });
});
