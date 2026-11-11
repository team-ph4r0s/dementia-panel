import type { Server } from '../types';
import type { EdgeKind, Health, TopoKind, TopoNode, Topology } from './model';

/**
 * План 3D-города (вид «Город» в разделе «Ноды») — чистая функция поверх buildTopology, без React и Three.js.
 * Город стоит на сетке кварталов: каждый узел топологии занимает свою клетку, поэтому здания не пересекаются.
 * Ноды, мосты и страны лежат на трёх кольцах вокруг штаба (панели) в той же стороне, что и на 2D-карте.
 * Сцена (city/scene.ts) только рисует план и ничего не решает о данных.
 */

/** Шаг сетки кварталов, единиц сцены */
export const BLOCK = 6;

export interface CityLot {
  key: string;
  kind: TopoKind;
  id: number | string;
  label: string;
  sub: string;
  health: Health;
  /** Центр основания */
  x: number;
  z: number;
  /** Ширина (по x), глубина (по z) и высота здания */
  w: number;
  d: number;
  h: number;
  /** Доля горящих окон: активные клиенты / все клиенты ноды */
  lit: number;
  flags: TopoNode['flags'];
}

export interface CityRoad {
  key: string;
  kind: EdgeKind;
  from: string;
  to: string;
  health: Health;
  /** По дороге идёт трафик: на ней ездят машины */
  flow: boolean;
  weight: number;
  /** Надземный переход (мост → нода) вместо улицы */
  elevated: boolean;
  /** Ломаная по плоскости x/z */
  points: [number, number][];
}

export interface CityPlan {
  lots: CityLot[];
  roads: CityRoad[];
  /** Сторона квадрата, в который помещаются все участки */
  size: number;
}

const FOOTPRINT: Record<TopoKind, number> = { panel: 0.78, server: 0.62, bridge: 0.55, country: 0.45 };
const MAX_CLIENTS_FOR_HEIGHT = 80;

/** Высота башни ноды: растёт с числом клиентов, но не бесконечно */
export function serverHeight(clientCount: number): number {
  return 7 + Math.min(Math.max(0, clientCount), MAX_CLIENTS_FOR_HEIGHT) * 0.38;
}

const HEIGHT: Record<Exclude<TopoKind, 'server'>, number> = { panel: 16, bridge: 5, country: 1 };

export interface CityFrame {
  /** Начальное расстояние камеры и пределы приближения */
  radius: number;
  min: number;
  max: number;
  /** Туман: начало и конец (от камеры) — город целиком перед концом тумана */
  fogNear: number;
  fogFar: number;
  /** Дальняя плоскость камеры */
  far: number;
}

/** Туман вокруг текущего расстояния камеры: ближний край города чёткий, дальний — ещё виден */
export function cityFog(radius: number, size: number): { near: number; far: number } {
  return { near: Math.max(10, radius - size * 0.5), far: radius + size * 1.3 + 40 };
}

/**
 * Кадр камеры для города стороной size на холсте с пропорцией aspect (ширина/высота).
 * На вертикальном экране (телефон) камера отъезжает дальше, чтобы город влез по ширине.
 */
export function frameCity(size: number, aspect: number): CityFrame {
  const narrow = aspect < 1 ? 1 / Math.max(0.45, aspect) : 1;
  const min = 25;
  const radius = Math.max(min, (size * 0.85 + 22) * Math.min(1.8, narrow * 0.9 + 0.1));
  const max = Math.max(260, size * 2.5, radius);
  const fog = cityFog(radius, size);
  return { radius, min, max, fogNear: fog.near, fogFar: fog.far, far: max + size + 60 };
}

type Cell = [number, number];

export function buildCity(
  topology: Topology,
  servers: Pick<Server, 'id' | 'client_count' | 'active_client_count'>[]
): CityPlan {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const taken = new Set<string>(['0,0']);
  const cellOf = new Map<string, Cell>([['panel', [0, 0]]]);

  const ring = (kind: TopoKind) => topology.nodes.filter((n) => n.kind === kind).sort((a, b) => a.key.localeCompare(b.key));
  const serversRing = ring('server');
  const bridgesRing = ring('bridge');
  const countriesRing = ring('country');

  // Радиусы колец в клетках: окружность должна вместить все узлы кольца с запасом
  const radiusFor = (count: number, min: number) => Math.max(min, (count * 1.25) / (2 * Math.PI));
  const r1 = radiusFor(serversRing.length, 2.5);
  const r2 = radiusFor(bridgesRing.length, r1 + 2);
  const r3 = radiusFor(countriesRing.length, (bridgesRing.length ? r2 : r1) + 2);
  const limit = Math.ceil(r3) + 4;

  /** Ближайшая свободная клетка к желаемой точке, не ближе minR к центру. Перебор детерминирован. */
  const place = (node: TopoNode, radius: number, minR: number) => {
    const wantX = Math.cos(node.angle) * radius;
    const wantZ = Math.sin(node.angle) * radius;
    let best: Cell | null = null;
    let bestDist = Infinity;
    for (let cx = -limit; cx <= limit; cx++) {
      for (let cz = -limit; cz <= limit; cz++) {
        if (taken.has(`${cx},${cz}`) || Math.hypot(cx, cz) < minR) continue;
        const dist = Math.hypot(cx - wantX, cz - wantZ);
        if (dist < bestDist - 1e-9) { best = [cx, cz]; bestDist = dist; }
      }
    }
    const cell = best ?? [limit, limit];
    taken.add(`${cell[0]},${cell[1]}`);
    cellOf.set(node.key, cell);
  };
  serversRing.forEach((n) => place(n, r1, 1.5));
  bridgesRing.forEach((n) => place(n, r2, r1 + 1));
  countriesRing.forEach((n) => place(n, r3, (bridgesRing.length ? r2 : r1) + 1));

  const lots: CityLot[] = [];
  let extent = 0;
  for (const node of topology.nodes) {
    const cell = cellOf.get(node.key);
    if (!cell) continue;
    extent = Math.max(extent, Math.abs(cell[0]), Math.abs(cell[1]));
    const side = BLOCK * FOOTPRINT[node.kind];
    let h: number;
    let lit = 0;
    if (node.kind === 'server') {
      const s = byId.get(node.id as number);
      const total = s?.client_count ?? 0;
      h = serverHeight(total);
      lit = total > 0 ? Math.min(1, (s?.active_client_count ?? 0) / total) : 0;
    } else {
      h = HEIGHT[node.kind];
    }
    lots.push({
      key: node.key, kind: node.kind, id: node.id, label: node.label, sub: node.sub, health: node.health,
      x: cell[0] * BLOCK, z: cell[1] * BLOCK, w: side, d: side, h, lit, flags: node.flags,
    });
  }

  const lotByKey = new Map(lots.map((l) => [l.key, l]));
  const half = BLOCK / 2;
  const roads: CityRoad[] = [];
  for (const edge of topology.edges) {
    const a = lotByKey.get(edge.from);
    const b = lotByKey.get(edge.to);
    if (!a || !b) continue;
    const elevated = edge.kind === 'bridge-server';
    // Улица идёт по линиям между кварталами: выезд на поперечную улицу, вдоль неё, затем к цели
    const points: [number, number][] = elevated
      ? [[a.x, a.z], [b.x, b.z]]
      : [[a.x, a.z], [a.x, a.z + half], [b.x + half, a.z + half], [b.x + half, b.z], [b.x, b.z]];
    roads.push({
      key: edge.key, kind: edge.kind, from: edge.from, to: edge.to, health: edge.health,
      flow: edge.flow, weight: edge.weight, elevated, points,
    });
  }

  return { lots, roads, size: (extent * 2 + 1) * BLOCK };
}
