import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Контраст текста темы по WCAG: подписи и плейсхолдеры (text-xs) должны читаться на всех поверхностях
// Путь от каталога теста: выражение new URL('./index.css', import.meta.url) Vite превращает в адрес ресурса
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8');
const token = (name: string) => {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`нет токена ${name}`);
  return m[1];
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(token(a)), luminance(token(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('контраст темы Data City', () => {
  it('второстепенный текст и подписи — не меньше 4.5:1 на карточках и вторичных фонах', () => {
    for (const text of ['ink', 'muted', 'faint']) {
      for (const surface of ['page', 'card', 'soft', 'soft-2']) {
        expect(contrast(text, surface), `${text} на ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('текст на яркой заливке (on-accent) читается на жёлтом, циане и мадженте', () => {
    for (const fill of ['brand', 'ok', 'bad']) expect(contrast('on-accent', fill), fill).toBeGreaterThanOrEqual(4.5);
  });
});
