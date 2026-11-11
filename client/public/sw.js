/*
 * Service worker панели (PWA): запуск приложения без сети и быстрая загрузка с телефона.
 *
 * ВАЖНО: воркер НИКОГДА не обрабатывает /api, /sub, /ws и /.well-known — там токены, конфигурации с приватными ключами и данные панели;
 * кешировать их нельзя. Кешируются только статические файлы самой панели: оболочка (index.html, сеть → запасной кеш) и собранные
 * файлы /assets/* с хэшем в имени (кеш → сеть). Тест — client/src/sw.test.ts; при правках не ослабляйте список NEVER (AGENTS.md, п. 44).
 */
const SHELL_CACHE = 'dementia-shell-v1';
const ASSET_CACHE = 'dementia-assets-v1';
const MAX_ASSETS = 120;
const NAVIGATION_TIMEOUT_MS = 6000;

/** Пути, которые воркер не трогает: запрос уходит в сеть как есть */
const NEVER = [/^\/api(\/|$)/, /^\/sub(\/|$)/, /^\/ws$/, /^\/\.well-known\//];
/** Мелкие статические файлы: показываем из кеша и обновляем в фоне */
const STATIC_FILES = /^\/(manifest\.webmanifest|favicon\.svg|icon-\d+\.png|icon-maskable-\d+\.png|apple-touch-icon\.png)$/;

const OFFLINE_HTML =
  '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="color-scheme" content="dark"><title>Нет связи</title></head>' +
  '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07060d;color:#f1f0ff;font-family:system-ui,sans-serif;text-align:center;padding:24px">' +
  '<div><h1 style="font-size:20px">Нет связи с панелью</h1><p style="color:#a29dbf">Проверьте подключение к сети и обновите страницу.</p>' +
  '<button onclick="location.reload()" style="padding:10px 20px;border-radius:8px;border:0;background:#fcee0a;color:#0a0900;font-weight:700;font-size:16px">Повторить</button></div></body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.all(['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png'].map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== SHELL_CACHE && name !== ASSET_CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

function isHtml(response) {
  return (response.headers.get('content-type') || '').includes('text/html');
}

/** Кешируем только успешные собственные ответы; HTML вместо файла (запасной маршрут сервера для несуществующего пути) не сохраняем */
function cacheable(response, { allowHtml }) {
  return response && response.ok && response.status === 200 && response.type !== 'opaque' && (allowHtml || !isHtml(response));
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    if (cacheable(response, { allowHtml: true })) await cache.put('/', response.clone());
    return response;
  } catch {
    const cached = await cache.match('/');
    return cached || new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function assetFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (cacheable(response, { allowHtml: false })) {
    await cache.put(request, response.clone());
    await trim(cache, MAX_ASSETS);
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (cacheable(response, { allowHtml: false })) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return hit || (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((pattern) => pattern.test(url.pathname))) return;
  // Запрос с токеном — это данные панели, а не файл интерфейса
  if (request.headers.has('authorization')) return;

  if (request.mode === 'navigate') {
    event.respondWith(shell(request));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(assetFirst(request));
  } else if (STATIC_FILES.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
