import { describe, it, expect } from 'vitest';
import type { Bridge, Server, Subscriber } from '../types';
import { buildTopology } from './model';
import { buildCity, frameCity, shouldReframe, type CityLot } from './city';

const server = (id: number, patch: Partial<Server> = {}): Server =>
  ({
    id, name: `node-${id}`, host: `10.0.0.${id}`, status: 'online', awg_version: 3, latest_awg_version: 3,
    remote_panel_id: null, needs_sync: false, needs_apply: false, client_count: 10, active_client_count: 4, probes: [],
    ...patch,
  }) as Server;

const bridge = (id: number, country: string, serverIds: number[]): Bridge =>
  ({
    id, name: `bridge-${id}`, country, status: 'online', needs_apply: false,
    links: serverIds.map((server_id) => ({ server_id, active: true, mode: 'auto', check_ok: true })),
  }) as Bridge;

const sub = (id: number, country: string | null, server_ids: number[]): Subscriber =>
  ({ id, name: `user-${id}`, country, server_ids, peer_count: 1 }) as Subscriber;

function city(servers: Server[], bridges: Bridge[] = [], subs: Subscriber[] = []) {
  return buildCity(buildTopology(servers, bridges, subs), servers);
}

const overlap = (a: CityLot, b: CityLot) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2;

const COUNTRIES = ['ru', 'kz', 'by', 'uz', 'am', 'ge', 'tr', 'de', 'nl', 'fi'];

function bigNetwork() {
  const servers = Array.from({ length: 40 }, (_, i) => server(i + 1, { client_count: (i * 7) % 60 }));
  const bridges = Array.from({ length: 6 }, (_, i) => bridge(i + 1, COUNTRIES[i], [i + 1, i + 10]));
  const subs = COUNTRIES.map((c, i) => sub(i + 1, c, [i + 1]));
  return { servers, bridges, subs };
}

describe('buildCity', () => {
  it('ставит ровно один участок на каждый узел топологии', () => {
    const { servers, bridges, subs } = bigNetwork();
    const topology = buildTopology(servers, bridges, subs);
    const plan = buildCity(topology, servers);
    expect(plan.lots.map((l) => l.key).sort()).toEqual(topology.nodes.map((n) => n.key).sort());
  });

  it('участки не пересекаются даже в большой сети', () => {
    const { servers, bridges, subs } = bigNetwork();
    const { lots } = city(servers, bridges, subs);
    for (let i = 0; i < lots.length; i++) {
      for (let j = i + 1; j < lots.length; j++) {
        expect(overlap(lots[i], lots[j]), `${lots[i].key} / ${lots[j].key}`).toBe(false);
      }
    }
  });

  it('все участки помещаются в квадрат size', () => {
    const { servers, bridges, subs } = bigNetwork();
    const plan = city(servers, bridges, subs);
    for (const l of plan.lots) {
      expect(Math.abs(l.x) + l.w / 2).toBeLessThanOrEqual(plan.size / 2);
      expect(Math.abs(l.z) + l.d / 2).toBeLessThanOrEqual(plan.size / 2);
    }
  });

  it('нода стоит с той же стороны, что на карте', () => {
    const servers = [1, 2, 3, 4, 5, 6].map((id) => server(id));
    const topology = buildTopology(servers, [], []);
    const plan = buildCity(topology, servers);
    for (const node of topology.nodes.filter((n) => n.kind === 'server')) {
      const lot = plan.lots.find((l) => l.key === node.key)!;
      const dot = lot.x * Math.cos(node.angle) + lot.z * Math.sin(node.angle);
      expect(dot, node.key).toBeGreaterThan(0);
    }
  });

  it('высота ноды растёт с числом клиентов', () => {
    const servers = [server(1, { client_count: 0 }), server(2, { client_count: 5 }), server(3, { client_count: 40 })];
    const h = (key: string) => city(servers).lots.find((l) => l.key === key)!.h;
    expect(h('server:1')).toBeLessThan(h('server:2'));
    expect(h('server:2')).toBeLessThan(h('server:3'));
  });

  it('пустая сеть — только штаб', () => {
    const plan = city([]);
    expect(plan.lots.map((l) => l.key)).toEqual(['panel']);
    expect(plan.roads).toEqual([]);
  });

  it('нода без клиентов: окна не горят, без деления на ноль', () => {
    const lot = city([server(1, { client_count: 0, active_client_count: 0 })]).lots.find((l) => l.key === 'server:1')!;
    expect(lot.lit).toBe(0);
    const half = city([server(1, { client_count: 10, active_client_count: 5 })]).lots.find((l) => l.key === 'server:1')!;
    expect(half.lit).toBeCloseTo(0.5);
  });

  it('дороги повторяют рёбра: flow копируется, мост соединён переходом', () => {
    const servers = [server(1), server(2, { status: 'offline' })];
    const topology = buildTopology(servers, [bridge(1, 'kz', [1])], [sub(1, 'ru', [1])]);
    const plan = buildCity(topology, servers);
    expect(plan.roads.map((r) => r.key).sort()).toEqual(topology.edges.map((e) => e.key).sort());
    for (const edge of topology.edges) expect(plan.roads.find((r) => r.key === edge.key)!.flow).toBe(edge.flow);
    expect(plan.roads.find((r) => r.kind === 'bridge-server')!.elevated).toBe(true);
    expect(plan.roads.find((r) => r.kind === 'panel-server')!.elevated).toBe(false);
    for (const r of plan.roads) expect(r.points.length).toBeGreaterThanOrEqual(2);
  });

  it('кадр камеры: город целиком в кадре и не тонет в тумане при любом размере и экране', () => {
    for (const nodes of [0, 8, 40, 100]) {
      const servers = Array.from({ length: nodes }, (_, i) => server(i + 1));
      const subs = COUNTRIES.map((c, i) => sub(i + 1, c, nodes ? [1] : []));
      const plan = city(servers, [], nodes ? subs : []);
      for (const aspect of [0.46, 1, 2]) {
        const f = frameCity(plan.size, aspect);
        const label = `${nodes} нод, aspect ${aspect}`;
        expect(f.radius, label).toBeLessThanOrEqual(f.max);
        expect(f.radius, label).toBeGreaterThanOrEqual(f.min);
        // Ближний край города дальше начала тумана, дальний — ближе его конца
        expect(f.fogNear, label).toBeGreaterThanOrEqual(f.radius - plan.size);
        expect(f.fogFar, label).toBeGreaterThan(f.radius + plan.size / 2);
        expect(f.far, label).toBeGreaterThanOrEqual(f.max + plan.size);
      }
    }
  });

  it('камера не входит в самую высокую башню на минимальном расстоянии', () => {
    const plan = city([server(1, { client_count: 80 })]);
    const tallest = Math.max(...plan.lots.map((l) => l.h));
    expect(frameCity(plan.size, 1, tallest).min).toBeGreaterThan(tallest * 1.3);
  });

  it('кадр пересчитывается, когда сеть заметно выросла и пользователь не приближал сам', () => {
    expect(shouldReframe(18, 42, false)).toBe(true);
    expect(shouldReframe(18, 24, false)).toBe(false);
    expect(shouldReframe(18, 42, true)).toBe(false);
  });

  it('дороги от штаба идут разными полосами, а не по одной линии', () => {
    const plan = city([1, 2, 3, 4, 5].map((id) => server(id)));
    const fromPanel = plan.roads.filter((r) => r.from === 'panel');
    const lanes = new Set(fromPanel.map((r) => r.points[1].join(',')));
    expect(lanes.size).toBe(fromPanel.length);
  });

  it('большая сеть (1500 нод) раскладывается быстро', () => {
    const servers = Array.from({ length: 1500 }, (_, i) => server(i + 1));
    const t0 = performance.now();
    const plan = city(servers);
    expect(plan.lots).toHaveLength(1501);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('детерминирован: одинаковые данные — одинаковый план', () => {
    const { servers, bridges, subs } = bigNetwork();
    expect(city(servers, bridges, subs)).toEqual(city(servers, bridges, subs));
  });
});
