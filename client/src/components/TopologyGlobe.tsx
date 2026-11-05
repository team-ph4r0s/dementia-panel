import { useEffect, useMemo, useRef, useState } from 'react';
import { geoGraticule10, geoPath } from 'd3-geo';
import type { Bridge, Server, Subscriber } from '../types';
import { countryName } from '../utils';
import { buildTopology, neighbours, nodeKey, type Selection, type TopoNode } from '../topology/model';
import {
  countries, DEFAULT_VIEW, GLOBE_CENTER, GLOBE_RADIUS, globeProjection, locateNodes, rotateGlobe, visibleOnGlobe, type GeoPoint,
} from '../topology/globe';

interface GlobeProps {
  servers: Server[];
  bridges: Bridge[];
  subscribers: Subscriber[];
  selected: Selection | null;
  onSelect: (next: Selection | null) => void;
}

const graticule = geoGraticule10();
const healthColors = { ok: 'var(--color-ok)', warn: 'var(--color-warn)', fail: 'var(--color-bad)', idle: 'var(--color-faint)' };

function nodeLabel(node: TopoNode) {
  return node.kind === 'country' && node.id !== '??' ? countryName(String(node.id)) : node.label;
}

function spreadMarker(point: GeoPoint, taken: GeoPoint[]): GeoPoint {
  for (let i = 0; i < 100; i++) {
    const radius = 13 * Math.sqrt(i);
    const angle = i * 2.4;
    const x = point[0] + Math.cos(angle) * radius;
    const y = point[1] + Math.sin(angle) * radius;
    if (Math.hypot(x - GLOBE_CENTER[0], y - GLOBE_CENTER[1]) <= GLOBE_RADIUS + 1
      && taken.every(([a, b]) => Math.hypot(a - x, b - y) >= 16)) return [x, y];
  }
  return point;
}

export function TopologyGlobe({ servers, bridges, subscribers, selected, onSelect }: GlobeProps) {
  const topology = useMemo(() => buildTopology(servers, bridges, subscribers), [servers, bridges, subscribers]);
  const locations = useMemo(() => locateNodes(topology.nodes, servers, bridges), [topology.nodes, servers, bridges]);
  const selectedKey = selected && nodeKey(selected.kind, selected.id);
  const initialView = locations.find(({ node }) => node.key === selectedKey)?.anchor
    ?? (locations.some(({ anchor }) => anchor && visibleOnGlobe(DEFAULT_VIEW, anchor))
      ? DEFAULT_VIEW : locations.find(({ anchor }) => anchor)?.anchor ?? DEFAULT_VIEW);
  const [view, setView] = useState<GeoPoint>(initialView);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const pendingRotation = useRef({ dx: 0, dy: 0, frame: 0 });
  useEffect(() => {
    const pending = pendingRotation.current;
    return () => cancelAnimationFrame(pending.frame);
  }, []);
  const connected = selectedKey ? neighbours(topology.edges, selectedKey) : null;
  const selectedRoutes = connected
    ? topology.edges.filter((edge) => edge.kind !== 'panel-server' && connected.edges.has(edge.key))
    : [];
  const projection = globeProjection(view);
  const path = geoPath(projection).digits(1);
  const positions = new Map(locations.flatMap(({ node, anchor }) => anchor ? [[node.key, anchor] as const] : []));
  const taken: GeoPoint[] = [];
  const markers = locations.flatMap(({ node, anchor }) => {
    if (!anchor || !visibleOnGlobe(view, anchor)) return [];
    const point = projection(anchor)!;
    const marker = spreadMarker(point, taken);
    taken.push(marker);
    return [{ node, marker, point }];
  });
  const markerByKey = new Map(markers.map(({ node, marker }) => [node.key, marker]));
  const choose = (key: string) => {
    const location = locations.find(({ node }) => node.key === key);
    if (!location || location.node.kind === 'panel') {
      onSelect(null);
      return;
    }
    if (location.anchor) setView(location.anchor);
    onSelect({ kind: location.node.kind, id: location.node.id });
  };
  const option = ({ node, code }: typeof locations[number]) => (
    <option key={node.key} value={node.key}>
      {node.kind === 'server' ? 'Нода' : node.kind === 'bridge' ? 'Мост' : 'Страна'} · {nodeLabel(node)}
      {node.kind === 'country' ? ` · ${node.sub}` : code ? ` · ${countryName(code)}` : ''}
    </option>
  );
  const unlocated = locations.filter(({ anchor }) => !anchor);

  return (
    <section data-guest-ok className="min-w-0 rounded-2xl border border-line bg-page/60 p-3 space-y-2" aria-label="Глобус сети">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select aria-label="Объект на глобусе" className="min-w-0 max-w-full rounded-lg bg-card border border-line px-2 py-2 text-xs text-ink"
          value={locations.some(({ node }) => node.key === selectedKey) ? selectedKey ?? '' : ''} onChange={(event) => choose(event.target.value)}>
          <option value="">Выберите объект</option>
          <optgroup label="На глобусе">{locations.filter(({ anchor }) => anchor).map(option)}</optgroup>
          {unlocated.length > 0 && <optgroup label="Без геопривязки">{unlocated.map(option)}</optgroup>}
        </select>
        <div className="flex gap-1 text-xs">
          {([
            ['←', 'Повернуть влево', -20, 0], ['→', 'Повернуть вправо', 20, 0],
            ['↑', 'Повернуть вверх', 0, -15], ['↓', 'Повернуть вниз', 0, 15],
          ] as const).map(([symbol, label, dx, dy]) => (
            <button key={label} type="button" className="rounded-lg border border-line bg-card px-3 py-2 text-ink hover:bg-soft" aria-label={label}
              onClick={() => setView((current) => rotateGlobe(current, dx, dy))}>{symbol}</button>
          ))}
          <button type="button" className="rounded-lg border border-line bg-card px-2 text-muted hover:text-ink" onClick={() => setView(initialView)}>Сброс</button>
        </div>
      </div>
      <svg viewBox="0 0 600 460" className="block w-full max-h-[65dvh] touch-none select-none cursor-grab active:cursor-grabbing" role="img"
        aria-label="Вращаемая карта мира. Для выбора объектов с клавиатуры используйте список над картой."
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest('[data-marker]')) return;
          drag.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const { clientX: x, clientY: y } = event;
          const pending = pendingRotation.current;
          pending.dx += x - drag.current.x;
          pending.dy += y - drag.current.y;
          drag.current = { x, y };
          if (pending.frame) return;
          pending.frame = requestAnimationFrame(() => {
            const { dx, dy } = pending;
            pending.dx = 0;
            pending.dy = 0;
            pending.frame = 0;
            setView((current) => rotateGlobe(current, dx * 0.45, dy * 0.45));
          });
        }}
        onLostPointerCapture={() => { drag.current = null; }}>
        <circle cx={GLOBE_CENTER[0]} cy={GLOBE_CENTER[1]} r={GLOBE_RADIUS} fill="var(--color-paper)" stroke="var(--color-line)" />
        <path d={path(countries) ?? undefined} fill="var(--color-soft-2)" stroke="var(--color-line)" strokeWidth={0.6} />
        <path d={path(graticule) ?? undefined} fill="none" stroke="var(--color-faint)" strokeWidth={0.35} opacity={0.5} />
        {topology.edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const same = from === to;
          const start = markerByKey.get(edge.from);
          const end = markerByKey.get(edge.to);
          const route = same && start && end
            ? `M${start.join(',')}L${end.join(',')}`
            : path({ type: 'LineString', coordinates: [from, to] });
          if (!route) return null;
          const stroke = edge.health === 'fail' || edge.health === 'warn' ? healthColors[edge.health]
            : edge.kind.includes('bridge') ? 'var(--color-violet)' : 'var(--color-brand)';
          const opacity = connected ? (connected.edges.has(edge.key) ? 1 : 0.12) : edge.flow ? 0.85 : 0.48;
          return <path key={edge.key} d={route} fill="none" stroke={stroke} strokeWidth={edge.flow ? 2 : 1.3}
            strokeDasharray={edge.dashed ? '4 4' : undefined} opacity={opacity}><title>{edge.title}</title></path>;
        })}
        {markers.map(({ node, marker: [x, y], point: [px, py] }) => {
          const fill = node.kind === 'bridge' ? 'var(--color-violet)' : node.kind === 'server' ? 'var(--color-brand)' : 'var(--color-info)';
          const active = selectedKey === node.key;
          return (
            <g key={node.key} data-marker="" className="cursor-pointer"
              opacity={connected && !connected.nodes.has(node.key) ? 0.4 : 1}
              onClick={() => node.kind !== 'panel' && onSelect({ kind: node.kind, id: node.id })}>
              <title>{nodeLabel(node)} · {node.sub}</title>
              <line x1={px} y1={py} x2={x} y2={y} stroke={fill} strokeWidth={0.8} opacity={0.6} />
              <circle cx={x} cy={y} r={10} fill="transparent" />
              <circle cx={x} cy={y} r={active ? 8 : 6} fill={fill} stroke={active ? 'var(--color-ink)' : 'var(--color-paper)'} strokeWidth={2} />
              <circle cx={x + 5} cy={y - 5} r={2.8} fill={healthColors[node.health]} stroke="var(--color-paper)" />
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="text-brand">● Ноды</span><span className="text-violet">● Мосты</span>
        <span className="text-info">● Страны подписчиков</span>
        <span className="text-muted">Дуги показывают маршруты подписок и настройки мостов</span>
      </div>
      {unlocated.length > 0 && <p className="text-xs text-muted">Без геопривязки: {unlocated.length}. Эти объекты доступны в списке над глобусом.</p>}
      {selectedRoutes.length > 0 && (
        <details className="rounded-lg border border-line bg-card px-3 py-2 text-xs">
          <summary className="cursor-pointer text-ink">Связи выбранного объекта · {selectedRoutes.length}</summary>
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-muted">
            {selectedRoutes.map((edge) => <li key={edge.key}>{edge.title}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
