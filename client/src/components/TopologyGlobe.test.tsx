import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Bridge, Server, Subscriber } from '../types';
import { TopologyGlobe } from './TopologyGlobe';

// С prefers-reduced-motion глобус поворачивается сразу, без анимации и автовращения: так проверяем итоговое положение.
const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = ((query: string) => ({ ...originalMatchMedia(query), matches: query.includes('reduce') })) as typeof window.matchMedia;
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

it('показывает ноды, мосты и подписчиков по странам, а объект без страны оставляет в списке', () => {
  const servers = [
    { id: 1, name: 'Финская нода', country: 'FI', status: 'online' },
    { id: 2, name: 'Без координат', status: 'online' },
    { id: 3, name: 'Нода в Океании', country: 'NZ', status: 'online' },
  ] as Server[];
  const bridge = { id: 1, name: 'Мост', country: 'fi', status: 'online', links: [] as Bridge['links'] } as Bridge;
  const subscribers = [{ id: 1, name: 'Тест', country: 'FI', server_ids: [1], peer_count: 1 }] as Subscriber[];
  const onSelect = vi.fn();
  render(<TopologyGlobe servers={servers} bridges={[bridge]} subscribers={subscribers} selected={null} onSelect={onSelect} />);

  const globe = screen.getByRole('img', { name: /карта мира/ });
  const markers = () => [...globe.querySelectorAll('[data-marker]')];
  expect(markers()).toHaveLength(3);
  const points = markers().map((marker) => marker.querySelector('circle')?.getAttribute('cx'));
  expect(new Set(points).size).toBe(3);
  expect(within(screen.getByRole('group', { name: 'Без геопривязки' })).getByRole('option')).toHaveTextContent('Без координат');

  fireEvent.change(screen.getByRole('combobox', { name: 'Объект на глобусе' }), { target: { value: 'server:3' } });
  expect(onSelect).toHaveBeenCalledWith({ kind: 'server', id: 3 });
  expect(markers()).toHaveLength(1);
  expect(markers()[0]).toHaveTextContent('Нода в Океании');
});

it('масштабирует кнопками и показывает стрелку к выбранному объекту за горизонтом', () => {
  const servers = [
    { id: 1, name: 'Финская нода', country: 'FI', status: 'online' },
    { id: 2, name: 'Нода в Океании', country: 'NZ', status: 'online' },
  ] as Server[];
  const props = { servers, bridges: [] as Bridge[], subscribers: [] as Subscriber[], onSelect: vi.fn() };
  const { rerender } = render(<TopologyGlobe {...props} selected={null} />);
  const globe = screen.getByRole('img', { name: /карта мира/ });
  expect(globe.querySelectorAll('[data-country-highlight]').length).toBeGreaterThan(0);
  expect(globe.querySelector('[data-horizon-pointer]')).toBeNull();

  expect(screen.getByRole('button', { name: 'Отдалить' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Приблизить' }));
  expect(screen.getByText(/×1\.4/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Отдалить' })).toBeEnabled();

  // Выбор снаружи (инспектор): глобус сразу поворачивается к объекту, стрелка не нужна.
  rerender(<TopologyGlobe {...props} selected={{ kind: 'server', id: 2 }} />);
  expect(globe.querySelector('[data-horizon-pointer]')).toBeNull();
  expect(screen.getByText('Нода · Нода в Океании')).toBeInTheDocument();
  // Пользователь отвернул глобус — у края появляется стрелка, по клику глобус возвращается.
  for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole('button', { name: 'Повернуть вправо' }));
  const pointer = globe.querySelector('[data-horizon-pointer]');
  expect(pointer).not.toBeNull();
  fireEvent.click(pointer!);
  expect(globe.querySelector('[data-horizon-pointer]')).toBeNull();
});
