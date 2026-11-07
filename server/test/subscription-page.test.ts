import { describe, expect, it } from 'vitest';
import { renderSubscriptionPage, SUBSCRIPTION_PAGE_SCRIPT } from '../src/routes/subscription-page.js';
import { appsFor, SUBSCRIPTION_APPS, subscriptionUrl } from '../src/utils/app-links.js';

const BASE = 'https://panel.example.com/sub/abc123';
const page = (extra: object = {}) => renderSubscriptionPage({
  title: 'Иван', status: 'Активна', active: true, expire: 0, used: 0, limit: 0, nodes: ['Германия'], url: BASE, ...extra,
});

describe('страница подписки: кнопки приложений', () => {
  it('даёт ссылки-схемы с полным адресом подписки нужного формата', () => {
    const html = page();
    expect(html).toContain(`href="incy://import/${BASE}"`);
    expect(html).toContain(`v2rayng://install-sub?url=${encodeURIComponent(BASE + '?format=v2ray').replaceAll('&', '&amp;')}`);
    expect(html).toContain(`hiddify://import/${BASE}?format=v2ray#`);
    expect(html).toContain(`flclash://install-config?url=${encodeURIComponent(BASE + '?format=clash')}`);
    expect(html).toContain(`shadowrocket://add/sub://${Buffer.from(BASE + '?format=v2ray').toString('base64')}`);
  });

  it('подписка только с AWG не предлагает приложения, не понимающие AmneziaWG', () => {
    const html = page({ protocols: ['awg'] });
    expect(html).toContain('Incy');
    expect(html).toContain('FlClash');
    expect(html).not.toContain('v2rayng://');
    expect(html).not.toContain('happ://');
  });

  it('экранирует название и не содержит встроенных скриптов и внешних ресурсов', () => {
    const html = page({ title: '"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc="\/sub\/page\.js")[^>]*>/);
    expect(html).not.toMatch(/(src|href)="https?:\/\/(?!panel\.example\.com)/);
  });

  it('каждое приложение строит непустую ссылку со своей схемой', () => {
    for (const app of SUBSCRIPTION_APPS) {
      const link = app.deepLink(subscriptionUrl(BASE, app.format), 'Имя');
      expect(link, app.id).toMatch(/^[a-z0-9-]+:\/\//);
      expect(link, app.id).not.toMatch(/[\s"<>]/);
    }
  });

  it('скрипт страницы — отдельный файл без обращений в сеть', () => {
    expect(SUBSCRIPTION_PAGE_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|WebSocket/);
  });
});
