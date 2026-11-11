/*
 * Генерирует иконки приложения (PNG для Android/iOS и favicon.svg) из одного рисунка: кольцо панели и три ноды-спутника.
 * Запуск (нужен Playwright с Chromium): NODE_PATH=$(npm root -g) node client/scripts/make-icons.cjs
 * Maskable-иконка держит рисунок внутри безопасной зоны (центральные 80%), чтобы Android мог обрезать её в круг или «каплю».
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const OUT = path.resolve(__dirname, '../public');
const BG = '#07060d';
const BRAND = '#fcee0a';

/** Рисунок в системе координат 512×512 */
const art = `
  <g stroke="#2a2446" stroke-width="3" fill="none">
    <circle cx="256" cy="256" r="150" stroke-dasharray="3 9"/>
  </g>
  <g stroke="${BRAND}" stroke-opacity=".55" stroke-width="5" stroke-linecap="round">
    <line x1="256" y1="168" x2="256" y2="112"/>
    <line x1="332" y1="300" x2="379" y2="327"/>
    <line x1="180" y1="300" x2="133" y2="327"/>
  </g>
  <circle cx="256" cy="256" r="92" fill="${BRAND}"/>
  <circle cx="256" cy="256" r="42" fill="${BG}"/>
  <circle cx="256" cy="94" r="22" fill="#00e5ff"/>
  <circle cx="394" cy="336" r="22" fill="#a78bfa"/>
  <circle cx="118" cy="336" r="22" fill="#ff9f1c"/>`;

const svg = (rounded) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="${BG}"/>${art}</svg>`;

/** Плитка с запасом по краям: для maskable рисунок уменьшается, чтобы вписаться в центральные 80% (иконка 512 → рисунок ~410) */
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BG}"/><g transform="translate(256 256) scale(.86) translate(-256 -256)">${art}</g></svg>`;

(async () => {
  fs.writeFileSync(path.join(OUT, 'favicon.svg'), svg(true) + '\n');
  const browser = await chromium.launch();
  const render = async (markup, size, file) => {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:${BG}}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`);
    await page.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  };
  await render(svg(false), 192, 'icon-192.png');
  await render(svg(false), 512, 'icon-512.png');
  await render(maskable, 512, 'icon-maskable-512.png');
  await render(svg(false), 180, 'apple-touch-icon.png');
  await browser.close();
  console.log('Иконки записаны в', OUT);
})();
