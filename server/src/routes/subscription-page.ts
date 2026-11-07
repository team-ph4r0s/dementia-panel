import { appsFor, subscriptionUrl, SUBSCRIPTION_APPS, type AppPlatform, type AppProtocol } from '../utils/app-links.js';

interface SubscriptionPage {
  title: string;
  status: string;
  active: boolean;
  expire: number;
  used: number;
  limit: number;
  nodes: string[];
  /** Полный адрес этой страницы без параметров — из него собираются ссылки для приложений */
  url?: string;
  /** Протоколы в подписке; по ним подбираются приложения (без них показываются все) */
  protocols?: AppProtocol[];
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatTraffic(bytes: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(bytes / 1024 ** 3) + ' ГиБ';
}

const PLATFORM_LABELS: Record<AppPlatform, string> = { android: 'Android', ios: 'iPhone / iPad', desktop: 'Windows / macOS / Linux' };

/** Скрипт страницы лежит отдельным файлом: CSP запрещает встроенные скрипты (инвариант 35) */
export const SUBSCRIPTION_PAGE_SCRIPT = `(function () {
  var ua = navigator.userAgent || '';
  var os = /android/i.test(ua) ? 'android' : /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : 'desktop';
  document.documentElement.setAttribute('data-os', os);
  var button = document.getElementById('copy');
  var field = document.getElementById('link');
  if (!button || !field) return;
  button.hidden = false;
  button.addEventListener('click', function () {
    var done = function () { button.textContent = 'Скопировано'; setTimeout(function () { button.textContent = 'Копировать'; }, 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(field.value).then(done, function () { field.select(); });
    else { field.select(); try { document.execCommand('copy'); done(); } catch (e) { /* выделено — скопируют вручную */ } }
  });
  field.addEventListener('focus', function () { field.select(); });
})();
`;

export function renderSubscriptionPage(page: SubscriptionPage): string {
  const title = escapeHtml(page.title);
  const expiry = page.expire
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' }).format(page.expire * 1000)
    : 'Бессрочно';
  const nodes = page.nodes.map((name) => `<li>${escapeHtml(name)}</li>`).join('');
  const percent = page.limit ? Math.min(100, Math.round((page.used / page.limit) * 100)) : 0;
  const base = page.url ?? '';
  const apps = page.protocols ? appsFor(new Set(page.protocols)) : SUBSCRIPTION_APPS;
  const groups = (['android', 'ios', 'desktop'] as AppPlatform[]).map((platform) => {
    const list = apps.filter((app) => app.platforms.includes(platform));
    if (!list.length || !base) return '';
    const buttons = list.map((app) => {
      const href = app.deepLink(subscriptionUrl(base, app.format), page.title);
      return `<a class="app" href="${escapeHtml(href)}" rel="noopener">${escapeHtml(app.name)}</a>`;
    }).join('');
    return `<div class="group g-${platform}"><h3>${PLATFORM_LABELS[platform]}</h3><div class="apps">${buttons}</div></div>`;
  }).join('');
  const shown = page.protocols ?? ['awg', 'vless'];
  const formats = [
    shown.includes('awg') ? '<a href="?format=awg" download>Incy / AWG</a>' : '',
    shown.includes('vless') ? '<a href="?format=v2ray" download>VLESS / v2ray</a>' : '',
    '<a href="?format=clash" download>mihomo</a>',
    '<a href="?format=json" download>JSON</a>',
  ].join('');
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#0b1220">
  <title>${title} · Dementia Panel</title>
  <style>
    :root { color-scheme: dark; --page: #0b1220; --card: #111a2c; --line: #24324d; --ink: #e6edf8; --muted: #93a3bd;
      --brand: #22d3ee; --on-accent: #04202a; --ok: #4ade80; --bad: #f87171; --mono: ui-monospace, Consolas, monospace; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); font: 16px/1.55 system-ui, sans-serif; background: var(--page); }
    .shell { width: min(880px, calc(100% - 32px)); margin-inline: auto; }
    header, footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px 20px; padding: 16px 0; }
    .label { color: var(--muted); font: 12px/1.5 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
    h1 { margin: 6px 0 4px; font-size: clamp(1.7rem, 6vw, 2.6rem); line-height: 1.1; letter-spacing: -.03em; overflow-wrap: anywhere; }
    h2 { margin: 0 0 12px; font-size: 1.15rem; }
    h3 { margin: 0 0 8px; color: var(--muted); font: 12px/1.5 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
    p { color: var(--muted); margin: 8px 0 0; }
    section { margin-top: 16px; }
    .card { border: 1px solid var(--line); border-radius: 16px; background: var(--card); padding: clamp(16px, 3vw, 24px); }
    .status { display: inline-flex; align-items: center; gap: .55em; font: 13px var(--mono); color: var(--bad); }
    .status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .status.active { color: var(--ok); }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 16px; }
    .stat { border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; }
    .stat b { display: block; font: 600 15px var(--mono); overflow-wrap: anywhere; }
    .bar { height: 6px; margin-top: 8px; border-radius: 3px; background: var(--line); overflow: hidden; }
    .bar i { display: block; height: 100%; background: var(--brand); }
    .copy { display: flex; gap: 8px; }
    .copy input { flex: 1; min-width: 0; padding: 10px 12px; color: var(--ink); background: var(--page); border: 1px solid var(--line);
      border-radius: 8px; font: 14px var(--mono); }
    button, a.app, .formats a { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 0 16px;
      border-radius: 8px; border: 1px solid var(--line); color: var(--ink); background: transparent; font: 600 15px system-ui, sans-serif;
      text-decoration: none; cursor: pointer; }
    button { background: var(--brand); border-color: var(--brand); color: var(--on-accent); }
    a.app { background: var(--brand); border-color: var(--brand); color: var(--on-accent); }
    a:hover, button:hover { filter: brightness(1.1); }
    a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
    .apps, .formats { display: flex; flex-wrap: wrap; gap: 8px; }
    .groups { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; }
    [data-os=android] .g-android, [data-os=ios] .g-ios, [data-os=desktop] .g-desktop { order: -1; }
    ol { margin: 0; padding: 0; list-style: none; counter-reset: node; }
    li { display: flex; gap: 14px; padding: 10px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
    li:first-child { border-top: 0; }
    li::before { counter-increment: node; content: counter(node, decimal-leading-zero); color: var(--brand); font-family: var(--mono); }
    footer { margin-top: 24px; border-top: 1px solid var(--line); }
  </style>
</head>
<body>
  <header class="shell"><strong>DEMENTIA PANEL</strong><span class="label">Подписка</span></header>
  <main class="shell">
    <section class="card" aria-labelledby="profile-title">
      <span class="label">Профиль подключения</span>
      <h1 id="profile-title">${title}</h1>
      <span class="status${page.active ? ' active' : ''}">${escapeHtml(page.status)}</span>
      <div class="stats">
        <div class="stat"><span class="label">Срок</span><b>${expiry}</b></div>
        <div class="stat"><span class="label">Трафик</span><b>${formatTraffic(page.used)} / ${page.limit ? formatTraffic(page.limit) : '∞'}</b>${page.limit ? `<div class="bar" role="img" aria-label="Использовано ${percent}%"><i style="width:${percent}%"></i></div>` : ''}</div>
        <div class="stat"><span class="label">Серверов</span><b>${page.nodes.length}</b></div>
      </div>
    </section>
    <section class="card" aria-labelledby="add-title">
      <h2 id="add-title">Добавить в приложение</h2>
      <p style="margin:0 0 12px">Нажмите на своё приложение — оно откроется и добавит подписку само. Если приложения нет в списке, скопируйте ссылку и вставьте её вручную.</p>
      <div class="copy"><input id="link" readonly value="${escapeHtml(base)}" aria-label="Ссылка на подписку"><button id="copy" type="button" hidden>Копировать</button></div>
      <div class="groups">${groups}</div>
      <p>Нет вашего приложения (например, v2rayN на ПК)? Вставьте скопированную ссылку в «Добавить подписку» — формат определится сам.</p>
    </section>
    <section class="card" aria-labelledby="nodes-title">
      <h2 id="nodes-title">Серверы</h2>
      ${nodes ? `<ol>${nodes}</ol>` : '<p>Доступных профилей пока нет.</p>'}
    </section>
    <section class="card" aria-labelledby="formats-title">
      <h2 id="formats-title">Скачать вручную</h2>
      <div class="formats">${formats}</div>
    </section>
  </main>
  <footer class="shell label"><span>Dementia Panel</span><span>Личная ссылка — не передавайте её другим</span></footer>
  <script src="/sub/page.js"></script>
</body>
</html>`;
}
