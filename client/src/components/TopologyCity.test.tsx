import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Bridge, Server, Subscriber } from '../types';
import { TopologyCity } from './TopologyCity';

// В jsdom нет WebGL: город показывает сообщение, а подписи зданий остаются кнопками — по ним можно выбирать объекты.
const servers = [
  { id: 1, name: 'Амстердам', status: 'online', client_count: 12, active_client_count: 5, remote_panel_id: null, probes: [] },
  { id: 2, name: 'Токио', status: 'offline', client_count: 3, active_client_count: 0, remote_panel_id: null, probes: [] },
] as unknown as Server[];
const bridges = [] as Bridge[];
const subscribers = [] as Subscriber[];

it('без WebGL показывает сообщение и предлагает открыть карту', () => {
  const onOpenMap = vi.fn();
  render(<TopologyCity servers={servers} bridges={bridges} subscribers={subscribers} selected={null} onSelect={vi.fn()} onOpenMap={onOpenMap} />);
  expect(screen.getByText('3D недоступно в этом браузере')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Открыть карту' }));
  expect(onOpenMap).toHaveBeenCalledTimes(1);
});

it('пустая сеть: город подсказывает, как добавить первую ноду', () => {
  render(<TopologyCity servers={[]} bridges={bridges} subscribers={subscribers} selected={null} onSelect={vi.fn()} onOpenMap={vi.fn()} />);
  expect(screen.getByText(/Нод пока нет/)).toBeInTheDocument();
});

it('подписи зданий — кнопки: нажатие выбирает ноду, выбранная отмечена', () => {
  const onSelect = vi.fn();
  const { rerender } = render(
    <TopologyCity servers={servers} bridges={bridges} subscribers={subscribers} selected={null} onSelect={onSelect} onOpenMap={vi.fn()} />
  );
  fireEvent.click(screen.getByRole('button', { name: /Токио/ }));
  expect(onSelect).toHaveBeenCalledWith({ kind: 'server', id: 2 });

  rerender(
    <TopologyCity servers={servers} bridges={bridges} subscribers={subscribers} selected={{ kind: 'server', id: 2 }} onSelect={onSelect} onOpenMap={vi.fn()} />
  );
  expect(screen.getByRole('button', { name: /Токио/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /Амстердам/ })).toHaveAttribute('aria-pressed', 'false');
  // Штаб (панель) выбрать нельзя — для него нет кнопки
  expect(screen.queryByRole('button', { name: /PANEL/ })).not.toBeInTheDocument();
});
