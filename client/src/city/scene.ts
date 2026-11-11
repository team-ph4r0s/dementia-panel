import * as THREE from 'three';
import { BLOCK, type CityLot, type CityPlan, type CityRoad } from '../topology/city';
import type { Health } from '../topology/model';

/**
 * Отрисовка вида «Город» на Three.js. Модуль только рисует план из buildCity (topology/city.ts) и сообщает о кликах;
 * решений о данных он не принимает. Грузится лениво вместе с TopologyCity — в основной бандл Three.js не попадает.
 */

export interface CityColors {
  page: string; line: string; ink: string; brand: string; ok: string; warn: string; bad: string; idle: string; violet: string; info: string;
}

/** Цвета берутся из токенов темы (index.css), чтобы не дублировать палитру */
export function readCityColors(el: Element = document.documentElement): CityColors {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(`--color-${name}`).trim() || fallback;
  return {
    page: v('page', '#07060d'), line: v('line', '#2a2446'), ink: v('ink', '#f1f0ff'), brand: v('brand', '#fcee0a'),
    ok: v('ok', '#00e5ff'), warn: v('warn', '#ff9f1c'), bad: v('bad', '#ff2e88'), idle: v('faint', '#6f6a8c'),
    violet: v('violet', '#a78bfa'), info: v('info', '#7aa2ff'),
  };
}

/** WebGL есть, если браузер умеет создавать контекст (в jsdom и очень старых WebView — нет) */
export function webglAvailable(): boolean {
  if (typeof window === 'undefined' || typeof WebGLRenderingContext === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export interface CityScene {
  update(plan: CityPlan): void;
  setSelected(key: string | null): void;
  setHover(key: string | null): void;
  /** Ключ участка под точкой экрана или null */
  pick(clientX: number, clientY: number): string | null;
  /** Положение верхушки здания в пикселях холста */
  project(key: string): { x: number; y: number; visible: boolean } | null;
  dispose(): void;
}

export interface CitySceneOptions {
  reducedMotion: boolean;
  colors: CityColors;
  /** Клик без перетаскивания: ключ участка или null (пустое место) */
  onPick?: (key: string | null) => void;
  onHover?: (key: string | null) => void;
  /** Вызывается после каждого кадра — обёртка двигает HTML-подписи */
  onFrame?: () => void;
}

/** Детерминированный псевдослучайный генератор: одинаковый план — одинаковые окна и кварталы */
function seeded(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function windowsTexture(lit: number, color: string, seed: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0c0a18';
  g.fillRect(0, 0, 64, 128);
  const rnd = seeded(seed);
  for (let y = 4; y < 128; y += 8) {
    for (let x = 4; x < 64; x += 8) {
      if (rnd() < lit) {
        g.globalAlpha = 0.55 + rnd() * 0.45;
        g.fillStyle = rnd() < 0.85 ? color : '#ffffff';
        g.fillRect(x, y, 4, 4);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Car { mesh: THREE.Mesh; road: CityRoad; length: number; t: number; speed: number; y: number }

export function createCityScene(canvas: HTMLCanvasElement, opts: CitySceneOptions): CityScene {
  const C = opts.colors;
  const healthColor = (h: Health) => (h === 'ok' ? C.ok : h === 'warn' ? C.warn : h === 'fail' ? C.bad : C.idle);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(C.page);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C.page, 60, 220);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 600);
  scene.add(new THREE.AmbientLight(0x3a3060, 1.4));
  const moon = new THREE.DirectionalLight(0x9a8cff, 0.8);
  moon.position.set(-40, 80, 30);
  scene.add(moon);

  // Камера по сферическим координатам вокруг центра города
  const target = new THREE.Vector3(0, 4, 0);
  const orbit = { theta: 0.75, phi: 0.95, radius: 80, min: 25, max: 260 };
  const placeCamera = () => {
    const r = orbit.radius;
    camera.position.set(
      target.x + r * Math.sin(orbit.phi) * Math.cos(orbit.theta),
      target.y + r * Math.cos(orbit.phi),
      target.z + r * Math.sin(orbit.phi) * Math.sin(orbit.theta)
    );
    camera.lookAt(target);
  };

  const world = new THREE.Group();
  scene.add(world);
  const meshes: THREE.Mesh[] = [];
  const lotParts = new Map<string, { lot: CityLot; edges: THREE.LineSegments; beacon: THREE.Mesh | null; base: string }>();
  let roadsLines: { road: CityRoad; line: THREE.Line | THREE.Mesh; base: number }[] = [];
  let cars: Car[] = [];
  let plan: CityPlan | null = null;
  let selected: string | null = null;
  let hover: string | null = null;
  let firstPlan = true;

  const disposeTree = (obj: THREE.Object3D) => {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) {
        for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.dispose();
        mat.dispose();
      }
    });
  };

  function buildLot(lot: CityLot) {
    const group = new THREE.Group();
    group.position.set(lot.x, 0, lot.z);
    const color =
      lot.kind === 'panel' ? C.brand : lot.kind === 'bridge' ? C.violet : lot.kind === 'country' ? C.info : healthColor(lot.health);
    const geo = new THREE.BoxGeometry(lot.w, lot.h, lot.d);
    geo.translate(0, lot.h / 2, 0);
    let material: THREE.Material;
    if (lot.kind === 'country') {
      material = new THREE.MeshLambertMaterial({ color: C.page, emissive: color, emissiveIntensity: 0.25 });
    } else {
      const lit = lot.kind === 'server' ? (lot.health === 'fail' || lot.health === 'idle' ? lot.lit * 0.15 : 0.12 + lot.lit * 0.75)
        : lot.kind === 'panel' ? 0.5 : 0.3;
      const tex = windowsTexture(lit, color, lot.key);
      tex.repeat.set(1, Math.max(1, lot.h / 10));
      material = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1 });
    }
    const body = new THREE.Mesh(geo, material);
    body.userData.key = lot.key;
    meshes.push(body);
    group.add(body);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color }));
    group.add(edges);

    let beacon: THREE.Mesh | null = null;
    if (lot.kind !== 'country') {
      beacon = new THREE.Mesh(new THREE.SphereGeometry(lot.kind === 'panel' ? 0.7 : 0.4, 14, 14), new THREE.MeshBasicMaterial({ color }));
      beacon.position.y = lot.h + 1.1;
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.4), new THREE.MeshBasicMaterial({ color }));
      spire.position.y = lot.h + 0.5;
      group.add(beacon, spire);
    }
    if (lot.flags.partner) {
      // Нода партнёра: антенна-тарелка на крыше
      const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.2, 0.4, 16, 1, true), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      dish.position.set(lot.w * 0.25, lot.h + 0.4, 0);
      dish.rotation.z = 0.5;
      group.add(dish);
    }
    world.add(group);
    lotParts.set(lot.key, { lot, edges, beacon, base: color });
  }

  function buildRoad(road: CityRoad, lots: Map<string, CityLot>) {
    const color = road.kind === 'bridge-server' ? C.violet : healthColor(road.health);
    const base = road.flow ? 0.85 : 0.3;
    let obj: THREE.Line | THREE.Mesh;
    let y = 0.06;
    if (road.elevated) {
      const a = lots.get(road.from)!;
      const b = lots.get(road.to)!;
      y = Math.min(a.h, b.h) * 0.6;
      const curve = new THREE.LineCurve3(new THREE.Vector3(road.points[0][0], y, road.points[0][1]), new THREE.Vector3(road.points[1][0], y, road.points[1][1]));
      obj = new THREE.Mesh(new THREE.TubeGeometry(curve, 8, 0.28, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: base }));
    } else {
      const pts = road.points.map(([x, z]) => new THREE.Vector3(x, y, z));
      obj = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: base }));
    }
    world.add(obj);
    roadsLines.push({ road, line: obj, base });
    if (!road.flow) return;
    let length = 0;
    for (let i = 1; i < road.points.length; i++) length += Math.hypot(road.points[i][0] - road.points[i - 1][0], road.points[i][1] - road.points[i - 1][1]);
    const count = 2 + Math.round(road.weight * 6);
    const rnd = seeded(road.key);
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.5), new THREE.MeshBasicMaterial({ color: i % 2 ? C.brand : color }));
      world.add(mesh);
      cars.push({ mesh, road, length, t: rnd(), speed: (4 + rnd() * 5) / Math.max(1, length), y: y + 0.15 });
    }
  }

  function buildFiller(p: CityPlan) {
    const half = Math.round(p.size / BLOCK / 2) + 2;
    const occupied = new Set(p.lots.map((l) => `${Math.round(l.x / BLOCK)},${Math.round(l.z / BLOCK)}`));
    const rnd = seeded('filler');
    const cells: [number, number, number][] = [];
    for (let i = -half; i <= half; i++) {
      for (let j = -half; j <= half; j++) {
        if (occupied.has(`${i},${j}`) || rnd() < 0.15) continue;
        const fall = 1 - Math.min(1, Math.hypot(i, j) / (half + 2));
        cells.push([i, j, 1.5 + rnd() * 7 * fall]);
      }
    }
    const tex = windowsTexture(0.1, C.violet, 'filler');
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5 });
    const inst = new THREE.InstancedMesh(geo, mat, cells.length);
    const m = new THREE.Matrix4();
    cells.forEach(([i, j, h], k) => {
      m.makeScale(BLOCK * 0.5, h, BLOCK * 0.5).setPosition(i * BLOCK, 0, j * BLOCK);
      inst.setMatrixAt(k, m);
    });
    world.add(inst);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(p.size + 300, p.size + 300), new THREE.MeshLambertMaterial({ color: C.page }));
    ground.rotation.x = -Math.PI / 2;
    world.add(ground);
    const grid = new THREE.GridHelper((half * 2 + 1) * BLOCK, half * 2 + 1, C.line, C.line);
    grid.position.set(0, 0.02, 0);
    world.add(grid);
  }

  function neighboursOf(key: string | null): Set<string> {
    const set = new Set<string>();
    if (!key || !plan) return set;
    set.add(key);
    for (const r of plan.roads) if (r.from === key || r.to === key) { set.add(r.from); set.add(r.to); }
    return set;
  }

  function applyEmphasis() {
    const focus = hover ?? selected;
    const near = neighboursOf(focus);
    for (const [key, part] of lotParts) {
      const mat = part.edges.material as THREE.LineBasicMaterial;
      mat.color.set(key === selected || key === hover ? C.brand : part.base);
    }
    for (const r of roadsLines) {
      const mat = r.line.material as THREE.Material & { opacity: number };
      mat.opacity = focus ? (near.has(r.road.from) && near.has(r.road.to) ? 1 : 0.12) : r.base;
    }
  }

  // --- Ввод: перетаскивание вращает, колесо и щипок приближают; клик без сдвига выбирает
  const pointers = new Map<number, { x: number; y: number }>();
  let downAt: { x: number; y: number } | null = null;
  let pinch = 0;
  let lastInput = performance.now();
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) downAt = { x: e.clientX, y: e.clientY };
    lastInput = performance.now();
  };
  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      const key = api.pick(e.clientX, e.clientY);
      if (key !== hover) opts.onHover?.(key);
      canvas.style.cursor = key ? 'pointer' : 'grab';
      return;
    }
    if (pointers.size === 2) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) orbit.radius = THREE.MathUtils.clamp(orbit.radius * (pinch / dist), orbit.min, orbit.max);
      pinch = dist;
    } else {
      orbit.theta += (e.clientX - prev.x) * 0.006;
      orbit.phi = THREE.MathUtils.clamp(orbit.phi - (e.clientY - prev.y) * 0.004, 0.35, 1.38);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    lastInput = performance.now();
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (downAt && pointers.size === 0 && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) {
      opts.onPick?.(api.pick(e.clientX, e.clientY));
    }
    if (pointers.size === 0) downAt = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    orbit.radius = THREE.MathUtils.clamp(orbit.radius * Math.exp(e.deltaY * 0.001), orbit.min, orbit.max);
    lastInput = performance.now();
  };
  const onLeave = () => { if (hover) opts.onHover?.(null); };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';

  // --- Размер, видимость и цикл анимации
  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(canvas);
  resize();
  let onScreen = true;
  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => { onScreen = entries.some((en) => en.isIntersecting); schedule(); })
    : null;
  io?.observe(canvas);
  const onVisibility = () => schedule();
  document.addEventListener('visibilitychange', onVisibility);

  let raf = 0;
  let last = performance.now();
  const clock = { t: 0 };
  function schedule() {
    if (!raf && onScreen && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const motion = opts.reducedMotion ? 0 : 1;
    clock.t += dt;
    if (motion && now - lastInput > 4000 && pointers.size === 0) orbit.theta += dt * 0.05;
    placeCamera();
    for (const car of cars) {
      car.t = (car.t + car.speed * dt * motion) % 1;
      let d = car.t * car.length;
      const pts = car.road.points;
      for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (d <= seg || i === pts.length - 1) {
          const f = seg ? Math.min(1, d / seg) : 0;
          car.mesh.position.set(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, car.y, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f);
          break;
        }
        d -= seg;
      }
    }
    for (const part of lotParts.values()) {
      if (!part.beacon) continue;
      const blink = part.lot.flags.sync && motion ? (Math.sin(clock.t * 8) > 0 ? 1.4 : 0.6) : 1;
      const pulse = motion && part.lot.health === 'ok' ? 1 + Math.sin(clock.t * 3 + part.lot.x) * 0.2 : 1;
      part.beacon.scale.setScalar(blink * pulse * (part.lot.key === selected ? 1.6 : 1));
    }
    renderer.render(scene, camera);
    opts.onFrame?.();
    schedule();
  }

  const vec = new THREE.Vector3();
  const api: CityScene = {
    update(next) {
      plan = next;
      for (const child of [...world.children]) { world.remove(child); disposeTree(child); }
      meshes.length = 0;
      lotParts.clear();
      roadsLines = [];
      cars = [];
      buildFiller(next);
      const lots = new Map(next.lots.map((l) => [l.key, l]));
      next.lots.forEach(buildLot);
      next.roads.forEach((r) => buildRoad(r, lots));
      if (firstPlan) {
        // Первый показ: весь город в кадре
        // На вертикальном экране (телефон) отъезжаем дальше, чтобы город влез по ширине
        const narrow = camera.aspect < 1 ? 1 / Math.max(0.45, camera.aspect) : 1;
        orbit.radius = THREE.MathUtils.clamp((next.size * 0.85 + 22) * Math.min(1.8, narrow * 0.9 + 0.1), orbit.min, orbit.max);
        orbit.max = Math.max(orbit.max, next.size * 2.5);
        firstPlan = false;
      }
      applyEmphasis();
      schedule();
    },
    setSelected(key) { selected = key; applyEmphasis(); schedule(); },
    setHover(key) { hover = key; applyEmphasis(); schedule(); },
    pick(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(meshes, false)[0];
      return (hit?.object.userData.key as string | undefined) ?? null;
    },
    project(key) {
      const part = lotParts.get(key);
      if (!part) return null;
      vec.set(part.lot.x, part.lot.h + 2.6, part.lot.z).project(camera);
      return {
        x: ((vec.x + 1) / 2) * canvas.clientWidth,
        y: ((1 - vec.y) / 2) * canvas.clientHeight,
        visible: vec.z < 1 && Math.abs(vec.x) <= 1.05 && Math.abs(vec.y) <= 1.05,
      };
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      disposeTree(world);
      renderer.dispose();
    },
  };
  placeCamera();
  return api;
}
