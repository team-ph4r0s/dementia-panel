import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import {
  buildSubscriptionHeaders,
  readSubscriptionSettings,
  renderTitle,
  updateSubscriptionSettings,
} from '../src/services/subscription-settings.service.js';
import { buildClashConfig, detectFormat } from '../src/routes/subscription.js';

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
  it('клиенты mihomo распознаются по User-Agent', () => {
    expect(detectFormat(undefined, 'clash-verge/v2.3.0')).toBe('clash');
    expect(detectFormat(undefined, 'FlClash/v0.8.80 clash-verge Platform/android')).toBe('clash');
    expect(detectFormat(undefined, 'mihomo/1.19.31')).toBe('clash');
    expect(detectFormat(undefined, 'Incy/1.0 (iOS)')).toBe('awg');
    expect(detectFormat('json', 'mihomo/1.19')).toBe('json');
    expect(detectFormat('awg', 'clash-verge/v2')).toBe('awg');
  });

  it('конфиг mihomo содержит amnezia-wg-option, H1–H4 — строки, имена уникальны', () => {
    const server = {
      host: '1.2.3.4', awg_port: 51820, server_public_key: 'PUB', preshared_key: 'PSK',
      jc: 4, jmin: 40, jmax: 70, s1: 30, s2: 100, h1: 111111111, h2: 222222222, h3: 333333333, h4: 444444444,
    };
    const client = { client_ip: '10.8.0.2', client_private_key: 'PRIV', preshared_key: 'CPSK' };
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
    expect(config.rules).toEqual(['MATCH,Dementia']);
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
});
