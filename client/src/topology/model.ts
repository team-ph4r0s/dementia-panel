import type { Bridge, BridgeLink, ProbeResult, Server, Subscriber } from '../types';

/** Выдаётся ли нода через мост пользователям его страны (как BridgeService.routesFor): main/always — всегда, auto — когда «нужен мост» */
export function linkInUse(link: Pick<BridgeLink, 'mode' | 'active' | 'cascade_pending'>): boolean {
  return !link.cascade_pending && (link.mode === 'main' || link.mode === 'always' || (link.mode === 'auto' && link.active));
}

const MODE_TITLE: Record<BridgeLink['mode'], string> = { main: 'основной', always: 'всегда', auto: 'авто', off: 'выключен' };

/**
 * Модель карты топологии: граф «панель → ноды → мосты → страны пользователей» строится из тех же данных, что уже
 * приходят в интерфейс (серверы с проверками из стран, мосты с привязками, подписчики со страной). Модель не знает про
 * SVG: раскладка по кольцам детерминирована, поэтому её можно проверять тестами.
 */
export type TopoKind = 'panel' | 'server' | 'bridge' | 'country';
export type Health = 'ok' | 'warn' | 'fail' | 'idle';

/** Страна, в которую попадают подписчики без выбранной страны */
export const UNKNOWN_COUNTRY = '??';

export interface TopoNode {
  key: string;
  kind: TopoKind;
  /** id сервера/моста или код страны */
  id: number | string;
  label: string;
  /** Короткая строка под названием: «17/42» пиров, «3 чел.» */
  sub: string;
  health: Health;
  x: number;
  y: number;
  /** Радиус значка в единицах карты */
  r: number;
  angle: number;
  flags: { partner?: boolean; sync?: boolean; outdated?: boolean };
}

export type EdgeKind = 'panel-server' | 'bridge-server' | 'country-bridge' | 'country-server';

export interface TopoEdge {
  key: string;
  kind: EdgeKind;
  from: string;
  to: string;
  health: Health;
  /** По линии идёт трафик (анимация и частицы) */
  flow: boolean;
  /** Резервный или обойдённый маршрут: тонкая пунктирная линия */
  dashed: boolean;
  /** Вес линии: пиры на ноде или число пользователей */
  weight: number;
  title: string;
}

export interface Topology {
  nodes: TopoNode[];
  edges: TopoEdge[];
  bounds: { x: number; y: number; w: number; h: number };
}

/** Что выбрано на карте: нода, мост или страна (панель и пустое место — «ничего») */
export interface Selection {
  kind: Exclude<TopoKind, 'panel'>;
  id: number | string;
}

export const nodeKey = (kind: TopoKind, id: number | string): string => (kind === 'panel' ? 'panel' : `${kind}:${id}`);

const TAU = Math.PI * 2;

function serverHealth(s: Server): Health {
  switch (s.status) {
    case 'online':
      return 'ok';
    case 'installing':
      return 'warn';
    case 'offline':
    case 'error':
      return 'fail';
    default:
      return 'idle';
  }
}

function bridgeHealth(b: Bridge): Health {
  switch (b.status) {
    case 'online':
      return 'ok';
    case 'installing':
      return 'warn';
    case 'offline':
    case 'error':
      return 'fail';
    default:
      return 'idle';
  }
}

function probeHealth(status: ProbeResult['status']): Health {
  return status === 'ok' ? 'ok' : status === 'partial' ? 'warn' : 'fail';
}

function worst(items: Health[]): Health {
  if (items.length === 0) return 'idle';
  if (items.includes('fail')) return 'fail';
  if (items.includes('warn')) return 'warn';
  return items.every((h) => h === 'ok') ? 'ok' : 'idle';
}

/** Среднее направление нескольких углов (учитывает переход через 2π) */
export function circularMean(angles: number[], fallback = 0): number {
  if (angles.length === 0) return fallback;
  const sx = angles.reduce((a, v) => a + Math.cos(v), 0);
  const sy = angles.reduce((a, v) => a + Math.sin(v), 0);
  if (Math.hypot(sx, sy) < 1e-9) return angles[0];
  return Math.atan2(sy, sx);
}

/**
 * Разводит значки на кольце: сортирует по желаемому углу и расталкивает соседей (включая пару у «шва» 2π→0), пока каждого
 * соседа не будет отделять зазор minGap. Значки остаются как можно ближе к своим связям.
 */
export function spreadAngles(items: { key: string; angle: number }[], minGap: number): Map<string, number> {
  const normalize = (a: number) => ((a % TAU) + TAU) % TAU;
  const sorted = items.map((i) => ({ key: i.key, angle: normalize(i.angle) })).sort((a, b) => a.angle - b.angle || a.key.localeCompare(b.key));
  const result = new Map<string, number>();
  const n = sorted.length;
  if (n === 0) return result;
  const gap = Math.min(minGap, TAU / n);
  const angles = sorted.map((i) => i.angle);
  for (let iteration = 0; iteration < 400 && n > 1; iteration++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const distance = angles[j] - angles[i] + (j === 0 ? TAU : 0);
      if (distance < gap - 1e-9) {
        const push = (gap - distance) / 2;
        angles[i] -= push;
        angles[j] += push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  sorted.forEach((it, idx) => result.set(it.key, angles[idx]));
  return result;
}

/**
 * Кольца вытянуты по горизонтали: холст карты широкий, и эллипс использует его площадь лучше круга. Растяжение по одной оси
 * не сближает значки, поэтому зазоры, посчитанные по окружности, сохраняются.
 */
export type Orientation = 'wide' | 'tall';

/** Коэффициенты растяжения колец по осям: на широком холсте — по горизонтали, на узком (телефон) — по вертикали */
export function stretchFor(orientation: Orientation): { sx: number; sy: number } {
  return orientation === 'tall' ? { sx: 1, sy: 1.4 } : { sx: 1.4, sy: 1 };
}

export function buildTopology(servers: Server[], bridges: Bridge[], subscribers: Subscriber[], orientation: Orientation = 'wide'): Topology {
  const { sx, sy } = stretchFor(orientation);
  const polar = (radius: number, angle: number) => ({ x: Math.cos(angle) * radius * sx, y: Math.sin(angle) * radius * sy });
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const serverById = new Map(servers.map((s) => [s.id, s]));

  // --- Ноды: равномерно по первому кольцу
  const sortedServers = [...servers].sort((a, b) => a.id - b.id);
  const ringServers = Math.max(190, (sortedServers.length * 130) / TAU);
  const serverAngle = new Map<number, number>();
  sortedServers.forEach((s, i) => serverAngle.set(s.id, (i / sortedServers.length) * TAU - Math.PI / 2));

  nodes.push({
    key: 'panel', kind: 'panel', id: 'panel', label: 'PANEL', sub: 'dementia', health: 'ok', x: 0, y: 0, r: 34, angle: 0, flags: {},
  });

  const activeMax = Math.max(1, ...servers.map((s) => s.active_client_count || 0));
  for (const s of sortedServers) {
    const angle = serverAngle.get(s.id)!;
    nodes.push({
      key: nodeKey('server', s.id),
      kind: 'server',
      id: s.id,
      label: s.name,
      sub: `${s.active_client_count || 0}/${s.client_count || 0}`,
      health: serverHealth(s),
      ...polar(ringServers, angle),
      r: 30,
      angle,
      flags: {
        partner: s.remote_panel_id !== null,
        sync: s.needs_sync || s.needs_apply,
        outdated: s.remote_panel_id === null && s.status !== 'uninstalled' && s.awg_version < s.latest_awg_version,
      },
    });
    const health = serverHealth(s);
    edges.push({
      key: `panel>${nodeKey('server', s.id)}`,
      kind: 'panel-server',
      from: 'panel',
      to: nodeKey('server', s.id),
      health,
      flow: s.status === 'online',
      dashed: s.status !== 'online',
      weight: (s.active_client_count || 0) / activeMax,
      title: `Панель → ${s.name}`,
    });
  }

  // --- Мосты: по второму кольцу, в сторону привязанных нод
  const ringBridges = ringServers + 135;
  const sortedBridges = [...bridges].sort((a, b) => a.id - b.id);
  const bridgeWant = sortedBridges.map((b, i) => ({
    key: nodeKey('bridge', b.id),
    angle: circularMean(
      b.links.map((l) => serverAngle.get(l.server_id)).filter((a): a is number => a !== undefined),
      (i / Math.max(1, sortedBridges.length)) * TAU
    ),
  }));
  const bridgeAngle = spreadAngles(bridgeWant, (2 * 70) / ringBridges);
  for (const b of sortedBridges) {
    const key = nodeKey('bridge', b.id);
    const angle = bridgeAngle.get(key)!;
    nodes.push({
      key, kind: 'bridge', id: b.id, label: b.name, sub: `${(b.country || '').toUpperCase()} · ${b.links.length} нод`,
      health: bridgeHealth(b), ...polar(ringBridges, angle), r: 24, angle, flags: { sync: b.needs_apply },
    });
    for (const link of b.links) {
      const server = serverById.get(link.server_id);
      if (!server) continue;
      const broken = b.status !== 'online' || link.check_ok === false;
      const live = !broken && linkInUse(link);
      edges.push({
        key: `${key}>${nodeKey('server', link.server_id)}`,
        kind: 'bridge-server',
        from: key,
        to: nodeKey('server', link.server_id),
        health: broken ? (b.status === 'online' ? 'fail' : bridgeHealth(b)) : live ? 'ok' : 'idle',
        flow: live,
        dashed: !live,
        weight: live ? 1 : 0,
        title: `Мост ${b.name} → ${server.name}: ${link.mode === 'auto' ? (link.active ? 'авто, включён' : 'авто, ожидает') : MODE_TITLE[link.mode]}`,
      });
    }
  }

  // --- Страны: подписчики, проверки из стран и страны мостов
  interface CountryInfo { code: string; users: number; peers: number; servers: Set<number> }
  const countries = new Map<string, CountryInfo>();
  const getCountry = (code: string): CountryInfo => {
    let c = countries.get(code);
    if (!c) countries.set(code, (c = { code, users: 0, peers: 0, servers: new Set() }));
    return c;
  };
  for (const sub of subscribers) {
    const c = getCountry(sub.country ? sub.country.toUpperCase() : UNKNOWN_COUNTRY);
    c.users += 1;
    c.peers += sub.peer_count || 0;
    for (const id of sub.server_ids) if (serverById.has(id)) c.servers.add(id);
  }
  const probeOf = new Map<string, ProbeResult>();
  for (const s of servers) {
    for (const p of s.probes ?? []) {
      const code = p.country.toUpperCase();
      probeOf.set(`${code}|${s.id}`, p);
      getCountry(code).servers.add(s.id);
    }
  }
  for (const b of bridges) if (b.country) getCountry(b.country.toUpperCase());

  const bridgesByCountry = new Map<string, Bridge[]>();
  for (const b of bridges) {
    const code = (b.country || '').toUpperCase();
    if (!code) continue;
    bridgesByCountry.set(code, [...(bridgesByCountry.get(code) ?? []), b]);
  }

  const ringCountries = Math.max(ringBridges + 120, (countries.size * 100) / TAU + ringBridges * 0.4);
  const countryList = [...countries.values()].sort((a, b) => a.code.localeCompare(b.code));
  const countryWant = countryList.map((c, i) => {
    const near = (bridgesByCountry.get(c.code) ?? []).map((b) => bridgeAngle.get(nodeKey('bridge', b.id))).filter((a): a is number => a !== undefined);
    const srv = [...c.servers].map((id) => serverAngle.get(id)).filter((a): a is number => a !== undefined);
    return { key: nodeKey('country', c.code), angle: circularMean(near.length ? near : srv, (i / Math.max(1, countryList.length)) * TAU) };
  });
  const countryAngle = spreadAngles(countryWant, (2 * 64) / ringCountries);

  for (const c of countryList) {
    const key = nodeKey('country', c.code);
    const angle = countryAngle.get(key)!;
    const myProbes = [...c.servers].map((id) => probeOf.get(`${c.code}|${id}`)).filter((p): p is ProbeResult => !!p);
    nodes.push({
      key, kind: 'country', id: c.code,
      label: c.code === UNKNOWN_COUNTRY ? 'Без страны' : c.code,
      sub: `${c.users} чел.`,
      health: worst(myProbes.map((p) => probeHealth(p.status))),
      ...polar(ringCountries, angle),
      r: 13 + Math.min(14, Math.sqrt(c.users) * 2.2),
      angle, flags: {},
    });

    const localBridges = bridgesByCountry.get(c.code) ?? [];
    for (const b of localBridges) {
      const live = b.status === 'online' && b.links.some((l) => linkInUse(l) && l.check_ok !== false);
      edges.push({
        key: `${key}>${nodeKey('bridge', b.id)}`,
        kind: 'country-bridge', from: key, to: nodeKey('bridge', b.id),
        health: bridgeHealth(b), flow: live, dashed: !live, weight: live ? c.users : 0,
        title: `${c.code} → мост ${b.name}`,
      });
    }
    for (const serverId of [...c.servers].sort((a, b) => a - b)) {
      const server = serverById.get(serverId)!;
      const probe = probeOf.get(`${c.code}|${serverId}`);
      const bypassed = localBridges.some((b) => b.status === 'online' && b.links.some((l) => l.server_id === serverId && linkInUse(l) && l.check_ok !== false));
      const health: Health = probe ? probeHealth(probe.status) : 'idle';
      edges.push({
        key: `${key}>${nodeKey('server', serverId)}`,
        kind: 'country-server', from: key, to: nodeKey('server', serverId),
        health,
        flow: !bypassed && server.status === 'online' && health !== 'fail',
        dashed: bypassed || health === 'fail' || !probe,
        weight: c.users,
        title: `${c.code} → ${server.name}: ${bypassed ? 'идёт через мост' : probe ? (probe.status === 'ok' ? 'доступна' : probe.status === 'partial' ? 'доступна не со всех узлов' : 'недоступна') : 'проверка не проводилась'}`,
      });
    }
  }

  return { nodes, edges, bounds: computeBounds(nodes) };
}

export function computeBounds(nodes: Pick<TopoNode, 'x' | 'y' | 'r'>[], pad = 56): { x: number; y: number; w: number; h: number } {
  if (nodes.length === 0) return { x: -300, y: -200, w: 600, h: 400 };
  const xs = nodes.flatMap((n) => [n.x - n.r - pad, n.x + n.r + pad]);
  const ys = nodes.flatMap((n) => [n.y - n.r - pad, n.y + n.r + pad]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Узлы и линии, связанные с выбранным: для подсветки при наведении */
export function neighbours(edges: TopoEdge[], key: string): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>([key]);
  const edgeKeys = new Set<string>();
  for (const e of edges) {
    if (e.from === key || e.to === key) {
      nodes.add(e.from);
      nodes.add(e.to);
      edgeKeys.add(e.key);
    }
  }
  return { nodes, edges: edgeKeys };
}
