import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Bridge, Server, Subscriber } from '../types';
import { TopologyGlobe } from './TopologyGlobe';

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
