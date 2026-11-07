import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { geoDistance, geoGraticule10, geoPath } from 'd3-geo';
import type { Bridge, Server, Subscriber } from '../types';
import { countryName } from '../utils';
import { buildTopology, neighbours, nodeKey, type Selection, type TopoNode } from '../topology/model';
import {
  clampZoom, countries, countriesWithObjects, DEFAULT_VIEW, flyTo, GLOBE_CENTER, GLOBE_RADIUS, globeProjection, horizonPointer,
  locateNodes, rotateGlobe, visibleOnGlobe, type GeoPoint,
} from '../topology/globe';

interface GlobeProps {
  servers: Server[];
  bridges: Bridge[];
  subscribers: Subscriber[];
  selected: Selection | null;
  onSelect: (next: Selection | null) => void;
}

const VIEW_W = 600;
const VIEW_H = 460;
/** Скорость автовращения, градусов долготы в секунду */
const SPIN_SPEED = 4;
/** Автовращение возобновляется после паузы без действий пользователя */
const SPIN_IDLE_MS = 6000;
const SPIN_START_MS = 1200;
const FLY_MS = 700;

const graticule = geoGraticule10();
const healthColors = { ok: 'var(--color-ok)', warn: 'var(--color-warn)', fail: 'var(--color-bad)', idle: 'var(--color-faint)' };
const kindColors = { server: 'var(--color-brand)', bridge: 'var(--color-violet)', country: 'var(--color-info)', panel: 'var(--color-brand)' };
const kindNames = { server: 'Нода', bridge: 'Мост', country: 'Страна', panel: 'Панель' };

/** Без matchMedia (старые WebView, тесты) анимации не запускаем: всё меняется сразу. */
function prefersReducedMotion() {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function nodeLabel(node: TopoNode) {
  return node.kind === 'country' && node.id !== '??' ? countryName(String(node.id)) : node.label;
}

function spreadMarker(point: GeoPoint, taken: GeoPoint[], radius: number): GeoPoint {
  for (let i = 0; i < 100; i++) {
    const step = 13 * Math.sqrt(i);
    const angle = i * 2.4;
    const x = point[0] + Math.cos(angle) * step;
    const y = point[1] + Math.sin(angle) * step;
    if (Math.hypot(x - GLOBE_CENTER[0], y - GLOBE_CENTER[1]) <= radius + 1
      && taken.every(([a, b]) => Math.hypot(a - x, b - y) >= 16)) return [x, y];
  }
  return point;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export function TopologyGlobe({ servers, bridges, subscribers, selected, onSelect }: GlobeProps) {
  const topology = useMemo(() => buildTopology(servers, bridges, subscribers), [servers, bridges, subscribers]);
  const locations = useMemo(() => locateNodes(topology.nodes, servers, bridges), [topology.nodes, servers, bridges]);
  const selectedKey = selected && nodeKey(selected.kind, selected.id);
  const selectedLocation = locations.find(({ node }) => node.key === selectedKey);
  const initialView = selectedLocation?.anchor
    ?? (locations.some(({ anchor }) => anchor && visibleOnGlobe(DEFAULT_VIEW, anchor))
      ? DEFAULT_VIEW : locations.find(({ anchor }) => anchor)?.anchor ?? DEFAULT_VIEW);
  const [view, setView] = useState<GeoPoint>(initialView);
  const [zoom, setZoom] = useState(1);
  const [spinOn, setSpinOn] = useState(() => !prefersReducedMotion());
  const [idle, setIdle] = useState(false);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const pendingRotation = useRef({ dx: 0, dy: 0, frame: 0 });
  const flight = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** Любое действие пользователя останавливает автовращение до паузы без действий. */
  const touch = useCallback((delay = SPIN_IDLE_MS) => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), delay);
  }, []);

  const flyToPoint = useCallback((target: GeoPoint) => {
    cancelAnimationFrame(flight.current);
    touch();
    if (prefersReducedMotion()) {
      setView(target);
      return;
    }
    const path = flyTo(viewRef.current, target);
    const started = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - started) / FLY_MS);
      setView(path(easeInOut(t)));
      if (t < 1) flight.current = requestAnimationFrame(frame);
    };
    flight.current = requestAnimationFrame(frame);
  }, [touch]);

  useEffect(() => {
    const pending = pendingRotation.current;
    idleTimer.current = setTimeout(() => setIdle(true), SPIN_START_MS);
    return () => {
      cancelAnimationFrame(pending.frame);
      cancelAnimationFrame(flight.current);
      clearTimeout(idleTimer.current);
    };
  }, [touch]);

  // Выбор снаружи (инспектор, карта) поворачивает глобус к объекту, если он далеко от центра.
  const selectedAnchor = selectedLocation?.anchor;
  useEffect(() => {
    if (selectedAnchor && geoDistance(viewRef.current, selectedAnchor) > 0.35) flyToPoint(selectedAnchor);
  }, [selectedKey, selectedAnchor, flyToPoint]);

  // Неспешное вращение, пока ничего не выбрано и пользователь не трогает глобус.
  const spinning = spinOn && idle && !selectedKey;
  useEffect(() => {
    if (!spinning) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      setView((current) => rotateGlobe(current, -SPIN_SPEED * dt / 1000, 0));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [spinning]);

  const changeZoom = useCallback((factor: number) => {
    touch();
    setZoom((current) => clampZoom(current * factor));
  }, [touch]);

  // Колесо мыши — масштаб; слушатель не пассивный, чтобы страница при этом не прокручивалась.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      changeZoom(Math.exp(-event.deltaY * 0.0015));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [changeZoom]);

  const connected = selectedKey ? neighbours(topology.edges, selectedKey) : null;
  const selectedRoutes = connected
    ? topology.edges.filter((edge) => edge.kind !== 'panel-server' && connected.edges.has(edge.key))
    : [];
  const radius = GLOBE_RADIUS * zoom;
  const projection = globeProjection(view, zoom);
  const path = geoPath(projection).digits(1);
  const positions = new Map(locations.flatMap(({ node, anchor }) => anchor ? [[node.key, anchor] as const] : []));
  // Результат поиска страны по точке кешируется в globe.ts: при вращении это дёшево.
  const highlighted = countriesWithObjects(locations.flatMap(({ code, anchor }) => code && anchor ? [code] : []));
  const selectedCode = selectedLocation?.anchor ? selectedLocation.code : undefined;
  const selectedCountry = countriesWithObjects(selectedCode ? [selectedCode] : []);
  const taken: GeoPoint[] = [];
  const markers = locations.flatMap(({ node, anchor }) => {
    if (!anchor || !visibleOnGlobe(view, anchor)) return [];
    const point = projection(anchor)!;
    const marker = spreadMarker(point, taken, radius);
    if (marker[0] < -10 || marker[0] > VIEW_W + 10 || marker[1] < -10 || marker[1] > VIEW_H + 10) return [];
    taken.push(marker);
    return [{ node, marker, point }];
  });
  const markerByKey = new Map(markers.map(({ node, marker }) => [node.key, marker]));
  const pointer = selectedAnchor ? horizonPointer(view, selectedAnchor, zoom) : undefined;
  const choose = (key: string) => {
    const location = locations.find(({ node }) => node.key === key);
    if (!location || location.node.kind === 'panel') {
      onSelect(null);
      return;
    }
    if (location.anchor) flyToPoint(location.anchor);
    onSelect({ kind: location.node.kind, id: location.node.id });
  };
  const option = ({ node, code }: typeof locations[number]) => (
    <option key={node.key} value={node.key}>
      {kindNames[node.kind]} · {nodeLabel(node)}
      {node.kind === 'country' ? ` · ${node.sub}` : code ? ` · ${countryName(code)}` : ''}
    </option>
  );
  const unlocated = locations.filter(({ anchor }) => !anchor);
  const placed = locations.length - unlocated.length;
  const button = 'min-h-10 min-w-10 lg:min-h-0 lg:min-w-0 rounded-lg border border-line bg-card px-3 py-2 text-ink hover:bg-soft btn-press';

  return (
    <section data-guest-ok className="min-w-0 rounded-2xl border border-line bg-page/60 p-3 space-y-2" aria-label="Глобус сети">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select aria-label="Объект на глобусе" className="min-w-0 max-w-full rounded-lg bg-card border border-line px-2 py-2 text-xs text-ink"
          value={selectedLocation ? selectedKey ?? '' : ''} onChange={(event) => choose(event.target.value)}>
          <option value="">Выберите объект</option>
          <optgroup label="На глобусе">{locations.filter(({ anchor }) => anchor).map(option)}</optgroup>
          {unlocated.length > 0 && <optgroup label="Без геопривязки">{unlocated.map(option)}</optgroup>}
        </select>
        <div className="flex flex-wrap gap-1 text-xs">
          {([
            ['←', 'Повернуть влево', -20, 0], ['→', 'Повернуть вправо', 20, 0],
            ['↑', 'Повернуть вверх', 0, -15], ['↓', 'Повернуть вниз', 0, 15],
          ] as const).map(([symbol, label, dx, dy]) => (
            <button key={label} type="button" className={button} aria-label={label}
              onClick={() => { touch(); setView((current) => rotateGlobe(current, dx, dy)); }}>{symbol}</button>
          ))}
          <button type="button" className={button} aria-label="Отдалить" disabled={zoom <= 1} onClick={() => changeZoom(1 / 1.4)}>−</button>
          <button type="button" className={button} aria-label="Приблизить" disabled={zoom >= 4} onClick={() => changeZoom(1.4)}>+</button>
          <button type="button" className={`${button} ${spinOn ? 'text-brand' : 'text-muted'}`} aria-pressed={spinOn}
            title="Медленно вращать глобус, пока ничего не выбрано" onClick={() => { setSpinOn((on) => !on); touch(SPIN_START_MS); }}>
            Вращение
          </button>
          <button type="button" className={`${button} text-muted hover:text-ink`}
            onClick={() => { setZoom(1); flyToPoint(initialView); }}>Сброс</button>
        </div>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img"
        className="block w-full max-h-[65dvh] touch-none select-none cursor-grab active:cursor-grabbing"
        aria-label="Вращаемая карта мира. Для выбора объектов с клавиатуры используйте список над картой."
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest('[data-marker]')) return;
          cancelAnimationFrame(flight.current);
          touch();
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const current = { x: event.clientX, y: event.clientY };
          pointers.current.set(event.pointerId, current);
          touch();
          if (pointers.current.size >= 2) {
            // Щипок двумя пальцами — масштаб.
            const [a, b] = [...pointers.current.values()];
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            if (pinch.current) setZoom((value) => clampZoom(value * distance / pinch.current!));
            pinch.current = distance;
            return;
          }
          const pending = pendingRotation.current;
          pending.dx += current.x - previous.x;
          pending.dy += current.y - previous.y;
          if (pending.frame) return;
          pending.frame = requestAnimationFrame(() => {
            const { dx, dy } = pending;
            pending.dx = 0;
            pending.dy = 0;
            pending.frame = 0;
            setView((value) => rotateGlobe(value, dx * 0.45 / zoom, dy * 0.45 / zoom));
          });
        }}
        onLostPointerCapture={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
        }}>
        {/* Атмосфера: несколько полупрозрачных колец вокруг диска */}
        {[18, 10, 4].map((width, index) => (
          <circle key={width} cx={GLOBE_CENTER[0]} cy={GLOBE_CENTER[1]} r={radius + width / 2} fill="none"
            stroke="var(--color-brand)" strokeWidth={width} strokeOpacity={0.04 + index * 0.04} />
        ))}
        <circle cx={GLOBE_CENTER[0]} cy={GLOBE_CENTER[1]} r={radius} fill="var(--color-paper)" stroke="var(--color-brand)" strokeOpacity={0.35} />
        <path d={path(graticule) ?? undefined} fill="none" stroke="var(--color-faint)" strokeWidth={0.35} opacity={0.45} />
        <path d={path(countries) ?? undefined} fill="var(--color-soft-2)" stroke="var(--color-line)" strokeWidth={0.6} />
        {/* Страны, где есть ноды, мосты или подписчики, подсвечены; страна выбранного объекта — ярче */}
        {[...highlighted].map((index) => {
          const shape = path(countries.features[index]);
          if (!shape) return null;
          const active = selectedCountry.has(index);
          return <path key={index} data-country-highlight="" d={shape} fill="var(--color-brand)" fillOpacity={active ? 0.32 : 0.14}
            stroke="var(--color-brand)" strokeOpacity={active ? 0.9 : 0.4} strokeWidth={active ? 1 : 0.6} />;
        })}
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
          const dimmed = connected && !connected.edges.has(edge.key);
          const opacity = connected ? (dimmed ? 0.12 : 1) : edge.flow ? 0.7 : 0.4;
          return (
            <g key={edge.key}>
              <path d={route} fill="none" stroke={stroke} strokeWidth={edge.flow ? 2 : 1.3}
                strokeDasharray={edge.dashed ? '4 4' : undefined} opacity={opacity}><title>{edge.title}</title></path>
              {/* Бегущие штрихи — по маршруту идёт трафик (отключаются при prefers-reduced-motion) */}
              {edge.flow && !edge.dashed && !dimmed && (
                <path d={route} fill="none" stroke="var(--color-ink)" strokeWidth={1.4} strokeLinecap="round"
                  className="topology-flow" opacity={0.75} pointerEvents="none" />
              )}
            </g>
          );
        })}
        {markers.map(({ node, marker: [x, y], point: [px, py] }) => {
          const fill = kindColors[node.kind];
          const active = selectedKey === node.key;
          const alarm = node.health === 'fail' || node.health === 'warn';
          return (
            <g key={node.key} data-marker="" className="cursor-pointer"
              opacity={connected && !connected.nodes.has(node.key) ? 0.4 : 1}
              onClick={() => { touch(); if (node.kind !== 'panel') onSelect({ kind: node.kind, id: node.id }); }}>
              <title>{nodeLabel(node)} · {node.sub}</title>
              <line x1={px} y1={py} x2={x} y2={y} stroke={fill} strokeWidth={0.8} opacity={0.6} />
              <circle cx={x} cy={y} r={11} fill="transparent" />
              {active && <circle cx={x} cy={y} r={13} fill="none" stroke={fill} strokeWidth={1.5} opacity={0.6} className="topology-breathe" />}
              <circle cx={x} cy={y} r={active ? 8 : 6} fill={fill} stroke={active ? 'var(--color-ink)' : 'var(--color-paper)'} strokeWidth={2} />
              <circle cx={x + 5} cy={y - 5} r={2.8} fill={healthColors[node.health]} stroke="var(--color-paper)"
                className={alarm ? 'topology-breathe' : undefined} />
            </g>
          );
        })}
        {/* Выбранный объект за горизонтом: стрелка на краю диска, по клику глобус поворачивается к нему */}
        {pointer && selectedLocation && (
          <g data-horizon-pointer="" className="cursor-pointer" onClick={() => selectedAnchor && flyToPoint(selectedAnchor)}
            transform={`translate(${pointer.x} ${pointer.y}) rotate(${pointer.angle})`}>
            <title>{nodeLabel(selectedLocation.node)} — за горизонтом, нажмите, чтобы повернуть</title>
            <circle r={14} fill="var(--color-card)" stroke={kindColors[selectedLocation.node.kind]} strokeWidth={1.5} />
            <path d="M-4,-6 L6,0 L-4,6 Z" fill={kindColors[selectedLocation.node.kind]} />
          </g>
        )}
      </svg>
      {selectedLocation && (
        <p className="text-xs text-muted">
          <span className="text-ink">{kindNames[selectedLocation.node.kind]} · {nodeLabel(selectedLocation.node)}</span>
          {selectedLocation.code && selectedLocation.node.kind !== 'country' ? <> · {countryName(selectedLocation.code)}</> : null}
          {!selectedLocation.anchor ? ' · страна не указана, на глобусе не показан'
            : pointer ? ' · за горизонтом, стрелка на краю глобуса показывает, куда повернуть' : null}
        </p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="text-brand">● Ноды</span><span className="text-violet">● Мосты</span>
        <span className="text-info">● Страны подписчиков</span>
        <span className="text-muted">Подсвечены страны с объектами · бегущие штрихи — маршруты с трафиком</span>
        <span className="text-faint font-mono">{placed} на глобусе · ×{zoom.toFixed(1)}</span>
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
