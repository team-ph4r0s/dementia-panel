import { geoContains, geoDistance, geoInterpolate, geoOrthographic } from 'd3-geo';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology as Atlas } from 'topojson-specification';
import atlasData from 'world-atlas/countries-110m.json';
import type { Bridge, Server } from '../types';
import type { TopoNode } from './model';
import countryAnchors from './country-anchors.json';

export type GeoPoint = [longitude: number, latitude: number];
export const GLOBE_CENTER: GeoPoint = [300, 230];
export const GLOBE_RADIUS = 212;
export const DEFAULT_VIEW: GeoPoint = [25, 37];
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

const atlas = atlasData as unknown as Atlas<{ countries: GeometryCollection }>;
export const countries = feature(atlas, atlas.objects.countries);
// Центроиды крупнейшей части каждой страны из Natural Earth (world-atlas 1:50m).
const anchors = countryAnchors as unknown as Partial<Record<string, GeoPoint>>;

// Опорные точки территорий, объединённых с другой геометрией или опущенных в атласе 1:50m.
const smallTerritories: Partial<Record<string, GeoPoint>> = {
  BV: [3.4, -54.4], CX: [105.6, -10.5], CC: [96.8, -12.2], GF: [-53.1, 4],
  GI: [-5.35, 36.14], GP: [-61.55, 16.2], MQ: [-61, 14.65], YT: [45.15, -12.8],
  RE: [55.53, -21.12], SJ: [18, 78.5], TK: [-172, -9], TV: [179.2, -8.5],
  UM: [-162.1, 6.4], BQ: [-68.25, 12.2], XK: [20.9, 42.6],
};

export function countryAnchor(code: string): GeoPoint | undefined {
  const key = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(key)) return undefined;
  return smallTerritories[key] ?? anchors[key];
}

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number.isFinite(zoom) ? zoom : MIN_ZOOM));
}

export function globeProjection(view: GeoPoint, zoom = 1) {
  return geoOrthographic().translate(GLOBE_CENTER).scale(GLOBE_RADIUS * clampZoom(zoom)).rotate([-view[0], -view[1]]).clipAngle(90);
}

/** Плавный перелёт к точке по дуге большого круга: t от 0 до 1. */
export function flyTo(from: GeoPoint, to: GeoPoint): (t: number) => GeoPoint {
  const step = geoInterpolate(from, to);
  return (t) => {
    const [lon, lat] = step(Math.max(0, Math.min(1, t)));
    return [lon, Math.max(-90, Math.min(90, lat))];
  };
}

/**
 * Стрелка на краю диска к точке за горизонтом: направление, в котором её нужно «подкрутить».
 * Для видимой точки — undefined. Точку в антиподе показываем сверху (направление не определено).
 */
export function horizonPointer(view: GeoPoint, point: GeoPoint, zoom = 1): { x: number; y: number; angle: number } | undefined {
  if (visibleOnGlobe(view, point)) return undefined;
  // Проекция точки (не потока) не обрезается: дальняя точка ложится зеркально внутрь диска — в нужном направлении.
  const flat = globeProjection(view, 1)(point);
  let dx = flat ? flat[0] - GLOBE_CENTER[0] : 0;
  let dy = flat ? flat[1] - GLOBE_CENTER[1] : 0;
  if (Math.hypot(dx, dy) < 1e-6) { dx = 0; dy = -1; }
  const angle = Math.atan2(dy, dx);
  // При приближении край диска уходит за рамку: держим стрелку внутри видимой области.
  const reach = Math.min(GLOBE_RADIUS * clampZoom(zoom), GLOBE_RADIUS) - 14;
  return { x: GLOBE_CENTER[0] + Math.cos(angle) * reach, y: GLOBE_CENTER[1] + Math.sin(angle) * reach, angle: angle * 180 / Math.PI };
}

/** Индексы стран атласа, где есть объекты сети: страна определяется по её опорной точке. */
const countryIndexCache = new Map<string, number>();

export function countriesWithObjects(codes: Iterable<string>): Set<number> {
  const result = new Set<number>();
  for (const value of codes) {
    const code = value.toUpperCase();
    let index = countryIndexCache.get(code);
    if (index === undefined) {
      const anchor = countryAnchor(code);
      index = anchor ? countries.features.findIndex((shape) => geoContains(shape, anchor)) : -1;
      countryIndexCache.set(code, index);
    }
    if (index >= 0) result.add(index);
  }
  return result;
}

export function visibleOnGlobe(view: GeoPoint, point: GeoPoint): boolean {
  return geoDistance(view, point) < Math.PI / 2;
}

export function rotateGlobe(view: GeoPoint, dx: number, dy: number): GeoPoint {
  return [((view[0] - dx + 180) % 360 + 360) % 360 - 180, Math.max(-90, Math.min(90, view[1] + dy))];
}

export function locateNodes(nodes: TopoNode[], servers: Server[], bridges: Bridge[]) {
  const serverCountries = new Map(servers.map((server) => [server.id, server.country]));
  const bridgeCountries = new Map(bridges.map((bridge) => [bridge.id, bridge.country]));
  return nodes.flatMap((node) => {
    if (node.kind === 'panel') return [];
    const code = (node.kind === 'server' ? serverCountries.get(Number(node.id))
      : node.kind === 'bridge' ? bridgeCountries.get(Number(node.id)) : String(node.id))?.toUpperCase();
    return [{ node, code, anchor: code ? countryAnchor(code) : undefined }];
  });
}
