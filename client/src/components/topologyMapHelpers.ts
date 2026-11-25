import { stretchFor, type Health, type Orientation, type TopoEdge, type TopoNode } from '../topology/model';

export const LAYOUT_KEY = 'dementia.topology.layout.v1';
export const LAYERS_KEY = 'dementia.topology.layers.v1';

export interface TopologyLayers {
  bridges: boolean;
  countries: boolean;
}

export type NodePositionOverrides = Record<string, { x: number; y: number }>;

export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const HEALTH_COLOR: Record<Health, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-orange)',
  fail: 'var(--color-pink)',
  idle: 'var(--color-faint)',
};

export const STATUS_TEXT: Record<Health, string> = { ok: 'в сети', warn: 'внимание', fail: 'нет связи', idle: 'не активна' };

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // хранилище недоступно (приватный режим) — карта работает и без запоминания
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Подгоняет область под соотношение сторон контейнера, чтобы карта не обрезалась и не «плавала» при перемещении */
export function fitView(bounds: View, aspect: number): View {
  const w = Math.max(bounds.w, bounds.h * aspect);
  const h = w / aspect;
  return { x: bounds.x + bounds.w / 2 - w / 2, y: bounds.y + bounds.h / 2 - h / 2, w, h };
}

export function zoomView(current: View, bounds: View, aspect: number, factor: number, focus?: Point): View {
  const base = fitView(bounds, aspect);
  const w = clamp(current.w * factor, base.w * 0.12, base.w * 3);
  const k = w / current.w;
  const fx = focus?.x ?? current.x + current.w / 2;
  const fy = focus?.y ?? current.y + current.h / 2;
  return { x: fx - (fx - current.x) * k, y: fy - (fy - current.y) * k, w, h: w / aspect };
}

/** Экранные координаты → координаты карты */
export function screenToMap(clientX: number, clientY: number, rect: ScreenRect, view: View): Point {
  return { x: view.x + ((clientX - rect.left) / rect.width) * view.w, y: view.y + ((clientY - rect.top) / rect.height) * view.h };
}

export function pinchView(startView: View, startDistance: number, currentDistance: number, midpoint: Point, rect: ScreenRect, aspect: number): View {
  const k = startDistance / currentDistance;
  const w = startView.w * k;
  const focus = screenToMap(midpoint.x, midpoint.y, rect, startView);
  return { x: focus.x - (focus.x - startView.x) * k, y: focus.y - (focus.y - startView.y) * k, w, h: w / aspect };
}

export function panView(startView: View, dx: number, dy: number, rect: ScreenRect): View {
  return { ...startView, x: startView.x - (dx / rect.width) * startView.w, y: startView.y - (dy / rect.height) * startView.h };
}

export function draggedNodePosition(nodeX: number, nodeY: number, dx: number, dy: number, rect: ScreenRect, view: View): Point {
  return { x: nodeX + (dx / rect.width) * view.w, y: nodeY + (dy / rect.height) * view.h };
}

export function orientationForSize(current: Orientation, width: number, height: number): Orientation {
  return current === 'wide' ? (width / height < 0.8 ? 'tall' : 'wide') : width / height > 1 ? 'wide' : 'tall';
}

export interface Geometry {
  d: string;
  /** Середина линии: сюда подвешивается подпись при подсветке */
  mx: number;
  my: number;
}

export function edgeGeometry(a: TopoNode, b: TopoNode, curve: boolean): Geometry {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const x1 = a.x + ux * (a.r + 3);
  const y1 = a.y + uy * (a.r + 3);
  const x2 = b.x - ux * (b.r + 3);
  const y2 = b.y - uy * (b.r + 3);
  if (!curve) return { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  const bend = len * 0.07;
  const cx = (x1 + x2) / 2 - uy * bend;
  const cy = (y1 + y2) / 2 + ux * bend;
  return { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`, mx: (x1 + 2 * cx + x2) / 4, my: (y1 + 2 * cy + y2) / 4 };
}

export function edgeStroke(edge: TopoEdge): string {
  if (edge.health === 'fail') return 'var(--color-pink)';
  if (edge.health === 'warn') return 'var(--color-orange)';
  if (edge.kind === 'bridge-server' || edge.kind === 'country-bridge') return edge.health === 'ok' ? 'var(--color-violet)' : 'var(--color-faint)';
  if (edge.kind === 'panel-server') return edge.health === 'ok' ? 'var(--color-brand)' : 'var(--color-faint)';
  return edge.health === 'ok' ? 'var(--color-info)' : 'var(--color-faint)';
}

export function edgeWidth(edge: TopoEdge, emphasised: boolean): number {
  return (edge.dashed ? 1.1 : 1.5) + (emphasised ? 1 : 0) + Math.min(1.2, edge.weight * 0.9);
}

export function edgeOpacity(edge: TopoEdge, dimmed: boolean, emphasised: boolean): number {
  if (dimmed) return 0.1;
  if (emphasised) return 1;
  if (edge.flow) return 0.75;
  return edge.kind === 'country-server' ? 0.35 : 0.55;
}

export function flowParticleCount(weight: number): number {
  return weight > 0.6 ? 3 : weight > 0.25 ? 2 : 1;
}

export function flowDuration(length: number): number {
  return Math.max(1.6, length / 90);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function visibleRingRadii(nodes: TopoNode[], layers: TopologyLayers, orientation: Orientation): number[] {
  const stretch = stretchFor(orientation);
  return [
    ...new Set(
      nodes
        .filter((n) => n.kind !== 'panel' && (layers.bridges || n.kind !== 'bridge') && (layers.countries || n.kind !== 'country'))
        .map((n) => Math.round(Math.hypot(n.x / stretch.sx, n.y / stretch.sy) / 10) * 10)
    ),
  ];
}

export function ringAxes(radius: number, orientation: Orientation): { rx: number; ry: number } {
  const stretch = stretchFor(orientation);
  return { rx: radius * stretch.sx, ry: radius * stretch.sy };
}

export function nodeColor(node: TopoNode): string {
  return node.kind === 'panel' ? 'var(--color-brand)' : node.kind === 'bridge' && node.health === 'ok' ? 'var(--color-violet)' : HEALTH_COLOR[node.health];
}

export function nodeAriaLabel(node: TopoNode): string {
  return node.kind === 'panel'
    ? 'Панель'
    : `${node.kind === 'server' ? 'Нода' : node.kind === 'bridge' ? 'Мост' : 'Страна'} ${node.label}: ${STATUS_TEXT[node.health]}, ${node.sub}`;
}

export function nodePrimaryLabel(node: TopoNode): string {
  return truncate(node.kind === 'country' || node.kind === 'panel' ? (node.kind === 'country' ? node.sub : 'dementia · панель') : node.label, 18);
}

/** Подписи не мельчают вместе с картой: их размер держится около 13 пикселей экрана при любом масштабе */
export function labelSizeForView(view: View | null, width: number): number {
  const pxPerUnit = view ? width / view.w : 1;
  return clamp(13 / pxPerUnit, 11, 18);
}

export function tooltipPosition(point: Point, width: number): Point {
  return { x: Math.min(point.x + 14, width - 270), y: Math.max(8, point.y - 12) };
}
