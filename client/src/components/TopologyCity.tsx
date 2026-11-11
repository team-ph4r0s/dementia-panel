import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bridge, Server, Subscriber } from '../types';
import { countryName } from '../utils';
import { buildTopology, nodeKey, UNKNOWN_COUNTRY, type Selection } from '../topology/model';
import { buildCity, type CityLot } from '../topology/city';
import { createCityScene, readCityColors, webglAvailable, type CityScene } from '../city/scene';

interface CityProps {
  servers: Server[];
  bridges: Bridge[];
  subscribers: Subscriber[];
  selected: Selection | null;
  onSelect: (next: Selection | null) => void;
  /** Без WebGL предлагаем 2D-карту */
  onOpenMap: () => void;
}

const kindNames = { server: 'Нода', bridge: 'Мост', country: 'Страна', panel: 'Панель' };

function lotTitle(lot: CityLot) {
  return lot.kind === 'country' && lot.id !== UNKNOWN_COUNTRY ? countryName(String(lot.id)) : lot.label;
}

function prefersReducedMotion() {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const healthDot = { ok: 'bg-ok', warn: 'bg-warn', fail: 'bg-bad', idle: 'bg-faint' };

/**
 * Вид «Город»: 3D-город сети (ноды — небоскрёбы, мосты — фиолетовые здания с переходами, страны — въезды).
 * План строит buildCity из той же модели, что карта и глобус; сцена (city/scene.ts) только рисует.
 * Подписи над зданиями — кнопки: город проходится с клавиатуры и работает как список, если WebGL недоступен.
 */
export function TopologyCity({ servers, bridges, subscribers, selected, onSelect, onOpenMap }: CityProps) {
  const plan = useMemo(() => buildCity(buildTopology(servers, bridges, subscribers), servers), [servers, bridges, subscribers]);
  const [supported] = useState(webglAvailable);
  const [hover, setHover] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<CityScene | null>(null);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectRef = useRef(onSelect);
  const lotsRef = useRef(plan.lots);
  useEffect(() => { selectRef.current = onSelect; lotsRef.current = plan.lots; });

  const selectedKey = selected && nodeKey(selected.kind, selected.id);
  const labelLots = plan.lots.filter((l) => l.kind !== 'panel');

  const pickKey = (key: string | null) => {
    const lot = key ? lotsRef.current.find((l) => l.key === key) : null;
    selectRef.current(lot && lot.kind !== 'panel' ? { kind: lot.kind, id: lot.id } : null);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!supported || !canvas) return;
    let scene: CityScene;
    try {
      scene = createCityScene(canvas, {
        reducedMotion: prefersReducedMotion(),
        colors: readCityColors(),
        onPick: pickKey,
        onHover: setHover,
        onFrame: () => {
          for (const [key, el] of labelRefs.current) {
            const p = scene.project(key);
            if (!p) continue;
            el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
            el.style.visibility = p.visible ? 'visible' : 'hidden';
          }
        },
      });
    } catch {
      return;
    }
    sceneRef.current = scene;
    return () => { scene.dispose(); sceneRef.current = null; };
    // Сцена создаётся один раз; данные приходят через update()
  }, [supported]);

  useEffect(() => { sceneRef.current?.update(plan); }, [plan]);
  useEffect(() => { sceneRef.current?.setSelected(selectedKey); }, [selectedKey]);
  useEffect(() => { sceneRef.current?.setHover(hover); }, [hover]);

  const labels = labelLots.map((lot) => {
    const active = lot.key === selectedKey;
    return (
      <button
        key={lot.key}
        ref={(el) => { if (el) labelRefs.current.set(lot.key, el); else labelRefs.current.delete(lot.key); }}
        type="button"
        aria-pressed={active}
        title={`${kindNames[lot.kind]}: ${lotTitle(lot)}${lot.flags.outdated ? ' — устаревший образ AWG' : ''}`}
        onClick={() => pickKey(lot.key)}
        onMouseEnter={() => setHover(lot.key)}
        onMouseLeave={() => setHover(null)}
        className={`flex items-center gap-1.5 whitespace-nowrap px-2 py-1 text-xs font-mono border-l-2 transition ${
          active ? 'bg-brand text-on-accent border-brand' : 'bg-page/85 text-ink border-line hover:border-brand'
        } ${supported ? 'absolute left-0 top-0 will-change-transform' : ''}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${lot.kind === 'bridge' ? 'bg-violet' : lot.kind === 'country' ? 'bg-info' : healthDot[lot.health]}`} />
        <span>{lotTitle(lot)}</span>
        <span className={active ? '' : 'text-muted'}>· {lot.sub}</span>
        {lot.flags.outdated && <span aria-hidden="true">↑</span>}
        {lot.flags.partner && <span className={active ? '' : 'text-faint'}>партнёр</span>}
      </button>
    );
  });

  if (!supported) {
    return (
      <section aria-label="Город сети" className="rounded-2xl border border-line bg-card p-5 space-y-4">
        <div className="space-y-2">
          <p className="font-display font-bold text-ink">3D недоступно в этом браузере</p>
          <p className="text-xs text-muted">Город рисуется через WebGL. Объекты сети можно выбрать ниже или открыть 2D-карту.</p>
          <button type="button" onClick={onOpenMap} className="px-4 py-2 rounded-lg bg-brand text-on-accent text-xs font-semibold btn-press">
            Открыть карту
          </button>
        </div>
        <div className="flex flex-wrap gap-2">{labels}</div>
      </section>
    );
  }

  return (
    <section
      aria-label="Город сети"
      className="relative overflow-hidden h-[58dvh] min-h-[380px] lg:h-[calc(100dvh-11.5rem)] lg:min-h-[520px] rounded-2xl border border-line bg-page"
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" aria-hidden="true" />
      <div className="absolute inset-0 pointer-events-none [&>button]:pointer-events-auto">{labels}</div>
      <p className="absolute left-3 bottom-3 text-xs text-faint pointer-events-none">Тяните — вращать · колесо или щипок — приблизить</p>
    </section>
  );
}
