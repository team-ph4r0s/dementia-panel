import { describe, expect, it } from 'vitest';
import { geoPath } from 'd3-geo';
import {
  clampZoom, countries, countriesWithObjects, countryAnchor, flyTo, GLOBE_CENTER, GLOBE_RADIUS, globeProjection, horizonPointer, rotateGlobe,
  visibleOnGlobe,
} from './globe';

describe('глобус', () => {
  it('находит опорные точки по коду страны, в том числе для малых территорий', () => {
    expect(countryAnchor('fi')).toEqual(countryAnchor('FI'));
    expect(countryAnchor('FI')?.[1]).toBeGreaterThan(59);
    expect(countryAnchor('GI')).toBeDefined();
    expect(countryAnchor('??')).toBeUndefined();
  });

  it('скрывает дальнее полушарие и обрезает маршрут по горизонту', () => {
    const view = [0, 0] as const;
    expect(visibleOnGlobe([...view], [0, 0])).toBe(true);
    expect(visibleOnGlobe([...view], [140, 0])).toBe(false);
    const projection = globeProjection([...view]);
    expect(projection([0, 0])).toEqual(GLOBE_CENTER);
    const path = geoPath(projection);
    expect(path({ type: 'LineString', coordinates: [[0, 0], [140, 0]] })).toMatch(/^M300,230.*512,230$/);
    expect(path({ type: 'LineString', coordinates: [[140, 0], [-140, 0]] })).toBeNull();
  });

  it('нормализует долготу через линию перемены дат и ограничивает широту', () => {
    expect(rotateGlobe([170, 85], -20, 20)).toEqual([-170, 90]);
  });

  it('ограничивает масштаб и увеличивает диск при приближении', () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(globeProjection([0, 0], 2)([90, 0])).toEqual([GLOBE_CENTER[0] + GLOBE_RADIUS * 2, GLOBE_CENTER[1]]);
  });

  it('стрелка к объекту за горизонтом смотрит в его сторону и остаётся в кадре при приближении', () => {
    expect(horizonPointer([0, 0], [10, 0])).toBeUndefined();
    const east = horizonPointer([0, 0], [150, 0])!;
    expect(east.x).toBeGreaterThan(GLOBE_CENTER[0]);
    expect(Math.abs(east.y - GLOBE_CENTER[1])).toBeLessThan(1e-6);
    const north = horizonPointer([0, 0], [0, -120])!; // через полюс на дальнюю сторону, «ниже» экватора
    expect(Math.abs(north.x - GLOBE_CENTER[0])).toBeLessThan(1e-6);
    const zoomed = horizonPointer([0, 0], [150, 0], 4)!;
    expect(zoomed.x).toBeCloseTo(east.x);
    // Точный антипод: направление не определено, показываем сверху
    const antipode = horizonPointer([0, 0], [180, 0])!;
    expect(antipode.y).toBeLessThan(GLOBE_CENTER[1]);
  });

  it('перелёт идёт по большому кругу от текущего вида к цели', () => {
    const path = flyTo([170, 0], [-170, 0]);
    expect(path(0)).toEqual([170, 0]);
    const middle = path(0.5);
    expect(Math.abs(Math.abs(middle[0]) - 180)).toBeLessThan(1e-6);
    expect(path(1)[0]).toBeCloseTo(-170);
  });

  it('подсвечивает страну по коду объекта и пропускает неизвестные коды', () => {
    const [finland] = countriesWithObjects(['fi']);
    expect((countries.features[finland].properties as { name?: string }).name).toBe('Finland');
    expect(countriesWithObjects(['FI', 'FI', '??', 'zz']).size).toBe(1);
  });
});
