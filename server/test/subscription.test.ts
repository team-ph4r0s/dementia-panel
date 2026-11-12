import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import {
  buildSubscriptionHeaders,
  readSubscriptionSettings,
  renderTitle,
  updateSubscriptionSettings,
} from '../src/services/subscription-settings.service.js';
import { buildClashConfig, detectFormat } from '../src/routes/subscription.js';
import { readDirectRouting, updateDirectRouting } from '../src/services/direct-routing.service.js';

beforeAll(() => {
  initDatabase();
});

describe('оформление подписки', () => {
  it('подставляет имя пользователя и обрезает название до 25 символов', () => {
    expect(renderTitle('{user}', 'Иван')).toBe('Иван');
    expect(renderTitle('VPN · {user}', 'Иван')).toBe('VPN · Иван');
    expect([...renderTitle('{user}', 'Очень длинное имя пользователя')].length).toBe(25);
  });

  it('все заголовки — допустимые для HTTP (ASCII), текст с кириллицей и эмодзи уходит в base64', () => {
    const settings = updateSubscriptionSettings({
      title: '🇩🇪 {user}',
      description: 'Быстрые серверы',
      announce: 'Плановые работы 15 ноября',
      support_url: 'https://t.me/поддержка',
      support_email: 'help@example.com',
      sort_order: 'ping',
      hide_url: true,
    });
    const headers = buildSubscriptionHeaders(settings, 'Иван');
    for (const value of Object.values(headers)) {
      expect(value).toMatch(/^[\x20-\x7e]*$/);
    }
    expect(Buffer.from(headers['Profile-Title'].slice(7), 'base64').toString()).toBe('🇩🇪 Иван');
    expect(headers['Announce'].startsWith('base64:')).toBe(true);
    expect(headers['Sort-Order']).toBe('ping');
    expect(headers['Hide-Url']).toBe('1');
    expect(readSubscriptionSettings().title).toBe('🇩🇪 {user}');
  });

  it('отклоняет некорректные значения', () => {
    expect(() => updateSubscriptionSettings({ support_url: 'javascript:alert(1)' })).toThrow();
    expect(() => updateSubscriptionSettings({ announce: 'x'.repeat(201) })).toThrow();
    expect(() => updateSubscriptionSettings({ title: 'x'.repeat(26) })).toThrow();
    expect(() => updateSubscriptionSettings({ sort_order: 'random' })).toThrow();
    expect(() => updateSubscriptionSettings({ support_email: 'не почта' })).toThrow();
  });
});

describe('форматы подписки', () => {
  const server = {
    host: '1.2.3.4', awg_port: 51820, server_public_key: 'PUB', preshared_key: 'PSK',
    jc: 4, jmin: 40, jmax: 70, s1: 30, s2: 100, h1: 111111111, h2: 222222222, h3: 333333333, h4: 444444444,
  };
  const client = { client_ip: '10.8.0.2', client_private_key: 'PRIV', preshared_key: 'CPSK' };

  it('клиенты mihomo распознаются по User-Agent', () => {
    expect(detectFormat(undefined, 'clash-verge/v2.3.0')).toBe('clash');
    expect(detectFormat(undefined, 'FlClash/v0.8.80 clash-verge Platform/android')).toBe('clash');
    expect(detectFormat(undefined, 'mihomo/1.19.31')).toBe('clash');
    expect(detectFormat(undefined, 'Incy/1.0 (iOS)')).toBe('awg');
    expect(detectFormat('json', 'mihomo/1.19')).toBe('json');
    expect(detectFormat('awg', 'clash-verge/v2')).toBe('awg');
  });

  it('конфиг mihomo содержит amnezia-wg-option, H1–H4 — строки, имена уникальны', () => {
    const config = JSON.parse(
      buildClashConfig(
        [
          { name: '🇩🇪 Германия', server, client },
          { name: '🇩🇪 Германия', server, client },
        ],
        ['1.1.1.1'],
        1280
      )
    );
    expect(config.proxies).toHaveLength(2);
    expect(config.proxies[1].name).toBe('🇩🇪 Германия 2');
    expect(config.proxies[0]['amnezia-wg-option']).toMatchObject({ jc: 4, s2: 100, h1: '111111111' });
    expect(config.proxies[0]['pre-shared-key']).toBe('CPSK');
    expect(config['proxy-groups'][0].proxies).toEqual(['🇩🇪 Германия', '🇩🇪 Германия 2']);
    expect(config.rules).toEqual(['IP-CIDR,1.2.3.4/32,DIRECT,no-resolve', 'MATCH,Dementia']);
  });

  it('mihomo: прокси с именем группы переименовывается; с одной нодой группы «Авто» нет', () => {
    const server = { host: '1.2.3.4', awg_port: 51820, server_public_key: 'PUB', jc: 4, jmin: 40, jmax: 70, s1: 30, s2: 100, h1: 1, h2: 2, h3: 3, h4: 4 };
    const client = { client_ip: '10.8.0.2', client_private_key: 'PRIV' };
    const config = JSON.parse(buildClashConfig([{ name: 'Авто', server, client }, { name: 'Dementia', server, client }], ['1.1.1.1'], 1280, true));
    expect(config.proxies.map((p: any) => p.name)).toEqual(['Авто 2', 'Dementia 2']);
    expect(config['proxy-groups'].map((g: any) => g.name)).toEqual(['Dementia', 'Авто']);
    expect(config['proxy-groups'][1].proxies).toEqual(['Авто 2', 'Dementia 2']);

    const single = JSON.parse(buildClashConfig([{ name: 'n', server, client }], ['1.1.1.1'], 1280, true));
    expect(single['proxy-groups']).toEqual([{ name: 'Dementia', type: 'select', proxies: ['n'] }]);
  });

  it('mihomo: адреса AWG идут напрямую до MATCH независимо от «Авто»', () => {
    for (const auto of [false, true]) {
      const config = JSON.parse(buildClashConfig([{ name: 'n', server, client }], ['1.1.1.1'], 1280, auto));
      expect(config.rules[0]).toBe('IP-CIDR,1.2.3.4/32,DIRECT,no-resolve');
      expect(config.rules.at(-1)).toBe('MATCH,Dementia');
    }
  });

  it('mihomo: IPv6-адреса AWG идут напрямую, домены не добавляются', () => {
    const ipv6 = JSON.parse(buildClashConfig([{ name: 'n', server: { ...server, host: '2001:db8::1' }, client }], [], 1280));
    expect(ipv6.rules).toEqual(['IP-CIDR6,2001:db8::1/128,DIRECT,no-resolve', 'MATCH,Dementia']);
    const domain = JSON.parse(buildClashConfig([{ name: 'n', server: { ...server, host: 'vpn.example.com' }, client }], [], 1280));
    expect(domain.rules).toEqual(['MATCH,Dementia']);
  });

  it('mihomo: VLESS и CDN не добавляют IP-адреса в правила', () => {
    const vless = {
      protocol: 'vless', host: '203.0.113.50', awg_port: 443, server_public_key: Buffer.alloc(32, 1).toString('base64'),
      reality_sni: 'www.microsoft.com', reality_short_ids: JSON.stringify(['0123456789abcdef']),
      xray_flow: 'xtls-rprx-vision', xray_fingerprint: 'chrome',
    };
    const vlessClient = { client_uuid: '123e4567-e89b-42d3-a456-426614174000' };
    const config = JSON.parse(buildClashConfig([
      { name: 'VLESS', server: vless, client: vlessClient },
      { name: 'CDN', server: { ...vless, via_cdn: true, cdn_address: '104.16.0.1', cdn_domain: 'cdn.example.com', cdn_port: 443 }, client: vlessClient },
    ], [], 1280));
    expect(config.proxies.map((p: any) => [p.type, p.server])).toEqual([['vless', '203.0.113.50'], ['vless', '104.16.0.1']]);
    expect(config.rules).toEqual(['MATCH,Dementia']);
  });

  it('mihomo: запасные порты не дублируют адрес и порядок адресов совпадает с порядком прокси', () => {
    const config = JSON.parse(buildClashConfig([
      { name: 'n', server, client },
      { name: 'другой', server: { ...server, host: '2001:db8::1' }, client },
      { name: 'запасной порт', server: { ...server, awg_port: 443 }, client },
      { name: 'напрямую', server, client },
    ], [], 1280, true));
    expect(config.rules).toEqual([
      'IP-CIDR,1.2.3.4/32,DIRECT,no-resolve', 'IP-CIDR6,2001:db8::1/128,DIRECT,no-resolve', 'MATCH,Dementia',
    ]);
  });

  it('mihomo: адреса AWG идут перед правилами «Напрямую»', () => {
    const previous = readDirectRouting();
    try {
      updateDirectRouting({ enabled: true, countries: ['ru'], domains: ['example.com'], cidrs: [] });
      const config = JSON.parse(buildClashConfig([{ name: 'n', server, client }], [], 1280));
      expect(config.rules).toEqual([
        'IP-CIDR,1.2.3.4/32,DIRECT,no-resolve',
        'DOMAIN-SUFFIX,ru,DIRECT', 'DOMAIN-SUFFIX,su,DIRECT', 'DOMAIN-SUFFIX,xn--p1ai,DIRECT',
        'DOMAIN-SUFFIX,example.com,DIRECT', 'GEOIP,RU,DIRECT,no-resolve', 'MATCH,Dementia',
      ]);
    } finally {
      updateDirectRouting(previous);
    }
  });
});
