import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bridge, Server, Subscriber } from '../types';
import { countryName } from '../utils';
import { buildTopology, nodeKey, UNKNOWN_COUNTRY, type Selection } from '../topology/model';
import { buildCity, type CityLot, type CityPlan } from '../topology/city';
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
  const fresh = useMemo(() => buildCity(buildTopology(servers, bridges, subscribers), servers), [servers, bridges, subscribers]);
  // Опрос и живые обновления приносят новые массивы с теми же данными: город перестраивается, только если план изменился
  const signature = JSON.stringify(fresh);
  const plan = useMemo(() => JSON.parse(signature) as CityPlan, [signature]);
  const [supported, setSupported] = useState(webglAvailable);
  const [hover, setHover] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sizesRef = useRef(new Map<string, { w: number; h: number }>());
  const sceneRef = useRef<CityScene | null>(null);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectRef = useRef(onSelect);
  const lotsRef = useRef(plan.lots);
  const selectedKey = selected && nodeKey(selected.kind, selected.id);
  const focusRef = useRef<{ selected: string | null; hover: string | null }>({ selected: null, hover: null });
  useEffect(() => {
    selectRef.current = onSelect;
    lotsRef.current = plan.lots;
    focusRef.current = { selected: selectedKey, hover };
  });
  const labelLots = plan.lots.filter((l) => l.kind !== 'panel');

  const pickKey = (key: string | null) => {
    const lot = key ? lotsRef.current.find((l) => l.key === key) : null;
    selectRef.current(lot && lot.kind !== 'panel' ? { kind: lot.kind, id: lot.id } : null);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!supported || !host) return;
    // У каждой сцены свой холст: при уходе из вида его WebGL-контекст освобождается сразу (dispose → forceContextLoss)
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 w-full h-full block';
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    const onLost = (e: Event) => { e.preventDefault(); setSupported(false); };
    canvas.addEventListener('webglcontextlost', onLost);
    let scene: CityScene;
    try {
      scene = createCityScene(canvas, {
        reducedMotion: prefersReducedMotion(),
        colors: readCityColors(),
        onPick: pickKey,
        onHover: setHover,
        onFrame: () => {
          // Подписи не наезжают друг на друга: важные ставятся первыми, остальные при пересечении гаснут
          // (но остаются в порядке Tab и видны в фокусе — .city-label:focus-visible в index.css)
          const { selected: sel, hover: hov } = focusRef.current;
          const rank = (key: string, kind: string) => (key === sel || key === hov ? 0 : kind === 'server' ? 1 : kind === 'bridge' ? 2 : 3);
          const order = lotsRef.current
            .filter((l) => labelRefs.current.has(l.key))
            .sort((a, b) => rank(a.key, a.kind) - rank(b.key, b.kind));
          const placed: { l: number; r: number; t: number; b: number }[] = [];
          for (const lot of order) {
            const el = labelRefs.current.get(lot.key)!;
            const p = scene.project(lot.key);
            if (!p) continue;
            el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
            el.style.visibility = p.visible ? 'visible' : 'hidden';
            if (!p.visible) continue;
            // Размер подписи меряется один раз (чтение offsetWidth в каждом кадре заставляло браузер пересчитывать стили)
            let size = sizesRef.current.get(lot.key);
            if (!size) { size = { w: el.offsetWidth, h: el.offsetHeight }; sizesRef.current.set(lot.key, size); }
            const { w, h } = size;
            const box = { l: p.x - w / 2 - 2, r: p.x + w / 2 + 2, t: p.y - h - 2, b: p.y + 2 };
            const clash = rank(lot.key, lot.kind) > 0 && placed.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t);
            el.style.opacity = clash ? '0' : '1';
            el.style.pointerEvents = clash ? 'none' : '';
            if (!clash) placed.push(box);
          }
        },
      });
    } catch {
      // WebGL есть, но контекст не создался (лимит контекстов, видеокарта в чёрном списке) — запасной экран
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.remove();
      queueMicrotask(() => setSupported(false));
      return;
    }
    sceneRef.current = scene;
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      scene.dispose();
      canvas.remove();
      sceneRef.current = null;
    };
    // Сцена создаётся один раз; данные приходят через update()
  }, [supported]);

  // Выбор или наведение на объект, которого уже нет в городе, сцене не передаётся — иначе город целиком тускнеет
  const liveKey = (key: string | null) => (key && plan.lots.some((l) => l.key === key) ? key : null);
  const sceneSelected = liveKey(selectedKey);
  const sceneHover = liveKey(hover);
  useEffect(() => { sizesRef.current.clear(); sceneRef.current?.update(plan); }, [plan]);
  useEffect(() => { sceneRef.current?.setSelected(sceneSelected); }, [sceneSelected]);
  useEffect(() => { sceneRef.current?.setHover(sceneHover); }, [sceneHover]);

  const labels = labelLots.map((lot) => {
    const active = lot.key === selectedKey;
    return (
      <button
        key={lot.key}
        ref={(el) => { if (el) labelRefs.current.set(lot.key, el); else labelRefs.current.delete(lot.key); }}
        type="button"
        aria-pressed={active}
        title={`${kindNames[lot.kind]}: ${lotTitle(lot)} · ${lot.sub}${lot.flags.outdated ? ' — устаревший образ AWG' : ''}`}
        onClick={() => pickKey(lot.key)}
        onMouseEnter={() => setHover(lot.key)}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(lot.key)}
        onBlur={() => setHover(null)}
        className={`city-label flex items-center gap-1.5 whitespace-nowrap px-2 py-1 text-xs font-mono border-l-2 transition-colors ${
          active ? 'bg-brand text-on-accent border-brand' : 'bg-page/85 text-ink border-line hover:border-brand'
        } ${supported ? 'absolute left-0 top-0 will-change-transform' : ''}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${lot.kind === 'bridge' ? 'bg-violet' : lot.kind === 'country' ? 'bg-info' : healthDot[lot.health]}`} />
        <span>{lotTitle(lot)}</span>
        {lot.kind !== 'country' && <span className={active ? '' : 'text-muted'}>· {lot.sub}</span>}
        {lot.flags.outdated && <span aria-hidden="true">↑</span>}
        {lot.flags.partner && <span className={active ? '' : 'text-faint'}>партнёр</span>}
      </button>
    );
  });

  const empty = !plan.lots.some((l) => l.kind === 'server');
  const emptyHint = empty && (
    <p className="text-sm text-muted">Нод пока нет — город начнётся со штаба. Добавьте первую ноду кнопкой «+ Нода» в шапке.</p>
  );

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
        {emptyHint}
        <div className="flex flex-wrap gap-2">{labels}</div>
      </section>
    );
  }

  return (
    <section
      ref={hostRef}
      aria-label="Город сети"
      className="hud-cut relative overflow-hidden h-[58dvh] min-h-[380px] lg:h-[calc(100dvh-11.5rem)] lg:min-h-[520px] rounded-2xl border border-line bg-page"
    >
      <div className="absolute inset-0 pointer-events-none [&>button]:pointer-events-auto">{labels}</div>
      {empty && <div className="absolute inset-x-4 top-4 bg-page/85 border border-line rounded-lg px-4 py-3 pointer-events-none">{emptyHint}</div>}
      <p className="absolute left-3 right-3 bottom-3 text-xs text-faint pointer-events-none">Тяните — вращать · Ctrl + колесо или щипок — приблизить</p>
    </section>
  );
}
