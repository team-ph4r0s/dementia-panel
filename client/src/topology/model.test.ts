import { describe, it, expect } from 'vitest';
import type { Bridge, ProbeResult, Server, Subscriber } from '../types';
import { buildTopology, circularMean, linkInUse, neighbours, spreadAngles, UNKNOWN_COUNTRY } from './model';

const server = (id: number, patch: Partial<Server> = {}): Server =>
  ({
    id, name: `node-${id}`, host: `10.0.0.${id}`, status: 'online', awg_version: 3, latest_awg_version: 3,
    remote_panel_id: null, needs_sync: false, needs_apply: false, client_count: 10, active_client_count: 4, probes: [],
    ...patch,
  }) as Server;

const probe = (serverId: number, country: string, status: ProbeResult['status']): ProbeResult =>
  ({ server_id: serverId, country, status, method: 'stub', ok_nodes: 1, total_nodes: 2, verified: true } as ProbeResult);

const bridge = (id: number, country: string, links: Array<[number, boolean]>, patch: Partial<Bridge> = {}): Bridge =>
  ({
    id, name: `bridge-${id}`, country, status: 'online', needs_apply: false,
    links: links.map(([server_id, active]) => ({ server_id, active, mode: 'auto', check_ok: true })),
    ...patch,
  }) as Bridge;

const sub = (id: number, country: string | null, server_ids: number[], peers = 1): Subscriber =>
  ({ id, name: `user-${id}`, country, server_ids, peer_count: peers }) as Subscriber;

describe('buildTopology', () => {
  it('строит панель, ноды, мосты и страны со связями', () => {
    const t = buildTopology(
      [server(1), server(2)],
      [bridge(1, 'kz', [[1, true]])],
      [sub(1, 'ru', [1, 2]), sub(2, 'ru', [1]), sub(3, 'kz', [2])]
    );
    expect(t.nodes.map((n) => n.key).sort()).toEqual(['bridge:1', 'country:KZ', 'country:RU', 'panel', 'server:1', 'server:2']);
    expect(t.edges.filter((e) => e.kind === 'panel-server')).toHaveLength(2);
    expect(t.edges.find((e) => e.key === 'bridge:1>server:1')).toMatchObject({ flow: true, health: 'ok' });
    expect(t.nodes.find((n) => n.key === 'country:RU')?.sub).toBe('2 чел.');
  });

  it('красит линию страна→нода по проверке из страны', () => {
    const t = buildTopology(
      [server(1, { probes: [probe(1, 'RU', 'ok'), probe(1, 'CN', 'fail'), probe(1, 'KZ', 'partial')] })],
      [],
      []
    );
    const health = (c: string) => t.edges.find((e) => e.key === `country:${c}>server:1`)?.health;
    expect(health('RU')).toBe('ok');
    expect(health('KZ')).toBe('warn');
    expect(health('CN')).toBe('fail');
    expect(t.edges.find((e) => e.key === 'country:CN>server:1')?.flow).toBe(false);
    expect(t.nodes.find((n) => n.key === 'country:CN')?.health).toBe('fail');
  });

  it('когда мост включён, прямой маршрут страны к ноде становится обходным, а через мост идёт трафик', () => {
    const t = buildTopology(
      [server(1, { probes: [probe(1, 'RU', 'fail')] })],
      [bridge(1, 'ru', [[1, true]])],
      [sub(1, 'ru', [1])]
    );
    const direct = t.edges.find((e) => e.key === 'country:RU>server:1')!;
    const viaBridge = t.edges.find((e) => e.key === 'country:RU>bridge:1')!;
    expect(direct).toMatchObject({ flow: false, dashed: true });
    expect(viaBridge).toMatchObject({ flow: true });
  });

  it('мост в режиме ожидания и сломанный мост не показывают поток', () => {
    const standby = buildTopology([server(1)], [bridge(1, 'ru', [[1, false]])], [sub(1, 'ru', [1])]);
    expect(standby.edges.find((e) => e.key === 'bridge:1>server:1')).toMatchObject({ flow: false, dashed: true, health: 'idle' });
    expect(standby.edges.find((e) => e.key === 'country:RU>server:1')?.flow).toBe(true);

    const broken = buildTopology([server(1)], [bridge(1, 'ru', [[1, true]], { status: 'offline' })], [sub(1, 'ru', [1])]);
    expect(broken.edges.find((e) => e.key === 'bridge:1>server:1')).toMatchObject({ flow: false, health: 'fail' });
    expect(broken.edges.find((e) => e.key === 'country:RU>server:1')?.flow).toBe(true);
  });

  it('подписчики без страны собираются в одну группу', () => {
    const t = buildTopology([server(1)], [], [sub(1, null, [1]), sub(2, null, [1])]);
    const node = t.nodes.find((n) => n.key === `country:${UNKNOWN_COUNTRY}`)!;
    expect(node.label).toBe('Без страны');
    expect(node.sub).toBe('2 чел.');
  });

  it('помечает ноды партнёров, ожидающие синхронизации и устаревшие', () => {
    const t = buildTopology(
      [server(1, { remote_panel_id: 7 }), server(2, { needs_sync: true }), server(3, { awg_version: 1 })],
      [], []
    );
    const flags = (id: number) => t.nodes.find((n) => n.key === `server:${id}`)!.flags;
    expect(flags(1).partner).toBe(true);
    expect(flags(2).sync).toBe(true);
    expect(flags(3).outdated).toBe(true);
    expect(flags(1).outdated).toBe(false);
  });

  it('статусы нод переходят в здоровье значка и линии', () => {
    const t = buildTopology([server(1, { status: 'offline' }), server(2, { status: 'installing' }), server(3, { status: 'uninstalled' })], [], []);
    expect(t.nodes.filter((n) => n.kind === 'server').map((n) => n.health)).toEqual(['fail', 'warn', 'idle']);
    expect(t.edges.every((e) => e.flow === false)).toBe(true);
  });

  it('работает без нод', () => {
    const t = buildTopology([], [], []);
    expect(t.nodes).toHaveLength(1);
    expect(t.edges).toHaveLength(0);
    expect(t.bounds.w).toBeGreaterThan(0);
  });

  it('раскладка детерминирована и значки одного кольца не налезают друг на друга', () => {
    const servers = Array.from({ length: 14 }, (_, i) => server(i + 1));
    const bridges = Array.from({ length: 6 }, (_, i) => bridge(i + 1, ['RU', 'KZ', 'BY', 'UA', 'GE', 'AM'][i], [[i + 1, true], [i + 2, false]]));
    const subs = ['ru', 'kz', 'by', 'ua', 'ge', 'am', 'uz', 'tr', 'cn', 'ir', 'az', 'kg'].flatMap((c, i) => [sub(i * 2, c, [1, 2]), sub(i * 2 + 1, c, [3])]);
    const a = buildTopology(servers, bridges, subs);
    const b = buildTopology(servers, bridges, subs);
    expect(a.nodes).toEqual(b.nodes);
    for (let i = 0; i < a.nodes.length; i++) {
      for (let j = i + 1; j < a.nodes.length; j++) {
        const p = a.nodes[i];
        const q = a.nodes[j];
        expect(Math.hypot(p.x - q.x, p.y - q.y), `${p.key} и ${q.key}`).toBeGreaterThan(p.r + q.r);
      }
    }
  });

  it('в узкой (высокой) раскладке значки тоже не налезают друг на друга', () => {
    const servers = Array.from({ length: 9 }, (_, i) => server(i + 1));
    const subs = ['ru', 'kz', 'by', 'ua', 'ge', 'am'].map((c, i) => sub(i, c, [1, 2, 3]));
    const t = buildTopology(servers, [bridge(1, 'RU', [[1, true]])], subs, 'tall');
    const wide = buildTopology(servers, [bridge(1, 'RU', [[1, true]])], subs, 'wide');
    expect(t.bounds.h).toBeGreaterThan(wide.bounds.h);
    for (let i = 0; i < t.nodes.length; i++) {
      for (let j = i + 1; j < t.nodes.length; j++) {
        const p = t.nodes[i];
        const q = t.nodes[j];
        expect(Math.hypot(p.x - q.x, p.y - q.y), `${p.key} и ${q.key}`).toBeGreaterThan(p.r + q.r);
      }
    }
  });

  it('мост ставится в сторону своих нод, а страна — в сторону своего моста', () => {
    const t = buildTopology(
      [server(1), server(2), server(3), server(4)],
      [bridge(1, 'RU', [[2, true]])],
      [sub(1, 'ru', [2])]
    );
    const pos = (key: string) => t.nodes.find((n) => n.key === key)!;
    const angleBetween = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y));
    expect(angleBetween(pos('bridge:1'), pos('server:2'))).toBeLessThan(0.1);
    expect(angleBetween(pos('country:RU'), pos('bridge:1'))).toBeLessThan(0.3);
  });
});

describe('вспомогательные функции', () => {
  it('circularMean учитывает переход через ноль', () => {
    const m = circularMean([0.1, -0.1 + Math.PI * 2]);
    expect(Math.cos(m)).toBeGreaterThan(0.99);
  });

  it('spreadAngles выдерживает минимальный зазор', () => {
    const r = spreadAngles([{ key: 'a', angle: 1 }, { key: 'b', angle: 1.01 }, { key: 'c', angle: 1.02 }], 0.3);
    const v = ['a', 'b', 'c'].map((k) => r.get(k)!);
    expect(v[1] - v[0]).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(v[2] - v[1]).toBeGreaterThanOrEqual(0.3 - 1e-9);
  });

  it('neighbours возвращает связанные узлы и линии', () => {
    const t = buildTopology([server(1), server(2)], [], []);
    const n = neighbours(t.edges, 'panel');
    expect([...n.nodes].sort()).toEqual(['panel', 'server:1', 'server:2']);
    expect(n.edges.size).toBe(2);
  });
});

describe('linkInUse: привязка моста выдаётся пользователям', () => {
  it('main и always — всегда, auto — только при «нужен мост», off — никогда', () => {
    expect(linkInUse({ mode: 'main', active: false })).toBe(true);
    expect(linkInUse({ mode: 'always', active: false })).toBe(true);
    expect(linkInUse({ mode: 'auto', active: false })).toBe(false);
    expect(linkInUse({ mode: 'auto', active: true })).toBe(true);
    expect(linkInUse({ mode: 'off', active: true })).toBe(false);
  });
});
