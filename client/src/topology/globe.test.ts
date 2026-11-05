import { describe, expect, it } from 'vitest';
import { geoPath } from 'd3-geo';
import { countryAnchor, GLOBE_CENTER, globeProjection, rotateGlobe, visibleOnGlobe } from './globe';

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
});
