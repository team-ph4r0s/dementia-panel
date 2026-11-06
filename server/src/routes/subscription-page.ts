interface SubscriptionPage {
  title: string;
  status: string;
  active: boolean;
  expire: number;
  used: number;
  limit: number;
  nodes: string[];
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatTraffic(bytes: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(bytes / 1024 ** 3) + ' ГиБ';
}

export function renderSubscriptionPage(page: SubscriptionPage): string {
  const title = escapeHtml(page.title);
  const expiry = page.expire
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' }).format(page.expire * 1000)
    : 'Бессрочно';
  const nodes = page.nodes.map((name) => `<li>${escapeHtml(name)}</li>`).join('');
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title} · Dementia Panel</title>
  <style>
    :root { color-scheme: dark; --paper: #0f0e0c; --card: #161410; --line: #423624; --ink: #f1e7d6;
      --muted: #bdb09b; --accent: #eeb451; --on-accent: #21180d; --mono: ui-monospace, Consolas, monospace; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); font: 16px/1.55 system-ui, sans-serif; background-color: var(--paper);
      background-image: linear-gradient(#d9a7560c 1px, transparent 1px), linear-gradient(90deg, #d9a7560c 1px, transparent 1px);
      background-size: 32px 32px; }
    .shell { width: min(1100px, calc(100% - 32px)); margin-inline: auto; }
    header, footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px 20px; padding: 18px 0; }
    header { border-bottom: 1px solid var(--line); }
    footer { border-top: 1px solid var(--line); }
    .label { color: var(--muted); font: 12px/1.5 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); align-items: center;
      gap: clamp(24px, 5vw, 64px); padding: clamp(40px, 8vw, 96px) 0 40px; }
    h1 { color: var(--accent); margin: 8px 0 16px; font-size: clamp(2rem, 6vw, 4.75rem);
      font-weight: 850; line-height: 1.04; letter-spacing: -.05em; overflow-wrap: anywhere; }
    h2 { margin: 0; font-size: 1.35rem; }
    p { color: var(--muted); margin: 12px 0 22px; }
    .card { border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: clamp(16px, 3vw, 28px); }
    .status { display: inline-block; border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; }
    .status::before { content: '●'; margin-right: .65em; color: var(--accent); }
    .status.active::before { color: #a3cc96; }
    dl { margin: 16px 0 0; font: 14px/1.5 var(--mono); }
    dl div { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap;
      gap: 4px 16px; padding: 10px 0; border-top: 1px solid var(--line); }
    dd { margin: 0; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; }
    a { display: inline-block; color: var(--ink); border: 1px solid var(--line); border-radius: 6px;
      padding: 10px 14px; font-weight: 650; text-decoration: none; }
    a:hover { border-color: var(--accent); }
    a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .primary { background: var(--accent); color: var(--on-accent); }
    .nodes { margin-bottom: 40px; }
    ol { margin: 12px 0 0; padding: 0; list-style: none; counter-reset: node; }
    li { display: flex; gap: 16px; padding: 10px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
    li::before { counter-increment: node; content: counter(node, decimal-leading-zero); color: var(--accent); font-family: var(--mono); }
    @media (max-width: 700px) { .hero { grid-template-columns: minmax(0, 1fr); } }
  </style>
</head>
<body>
  <header class="shell"><strong>DEMENTIA PANEL</strong><span class="label">AmneziaWG / VLESS / Подписка</span></header>
  <main class="shell">
    <section class="hero" aria-labelledby="profile-title">
      <div>
        <span class="label">Профиль подключения</span>
        <h1 id="profile-title">${title}</h1>
        <p>Скопируйте адрес этой страницы и добавьте его в VPN-клиент как ссылку на подписку.</p>
        <nav aria-label="Форматы подписки">
          <a class="primary" href="?format=awg" download>Скачать Incy / AWG</a>
          <a href="?format=v2ray" download>VLESS / v2ray</a>
          <a href="?format=clash" download>mihomo</a>
          <a href="?format=json" download>JSON</a>
        </nav>
        <p><strong>Приложения для VLESS:</strong><br>
          Android — v2rayNG, Hiddify; iPhone / iPad — Streisand, Happ; ПК — Hiddify, v2rayN.</p>
      </div>
      <section class="card" aria-labelledby="status-title">
        <h2 id="status-title">Параметры подписки</h2>
        <p class="label status${page.active ? ' active' : ''}">${escapeHtml(page.status)}</p>
        <dl>
          <div><dt>Срок действия</dt><dd>${expiry}</dd></div>
          <div><dt>Трафик</dt><dd>${formatTraffic(page.used)} / ${page.limit ? formatTraffic(page.limit) : 'Без лимита'}</dd></div>
          <div><dt>Доступные профили</dt><dd>${page.nodes.length}</dd></div>
        </dl>
      </section>
    </section>
    <section class="card nodes" aria-labelledby="nodes-title">
      <h2 id="nodes-title">Серверы</h2>
      ${nodes ? `<ol>${nodes}</ol>` : '<p>Доступных профилей пока нет.</p>'}
    </section>
  </main>
  <footer class="shell label"><span>Dementia Panel</span><span>Личная ссылка</span></footer>
</body>
</html>`;
}
