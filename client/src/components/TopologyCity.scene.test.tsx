import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Bridge, Server, Subscriber } from '../types';

// Сцена подменена: проверяем, как обёртка с ней обращается, когда WebGL «есть»
const sceneApi = { update: vi.fn(), setSelected: vi.fn(), setHover: vi.fn(), pick: vi.fn(), project: vi.fn(() => null), dispose: vi.fn() };
const create = vi.fn((): typeof sceneApi => sceneApi);
vi.mock('../city/scene', () => ({
  webglAvailable: () => true,
  readCityColors: () => ({}),
  createCityScene: () => create(),
}));

const { TopologyCity } = await import('./TopologyCity');

const makeServers = () =>
  [
    { id: 1, name: 'Амстердам', status: 'online', client_count: 12, active_client_count: 5, remote_panel_id: null, probes: [] },
    { id: 2, name: 'Токио', status: 'online', client_count: 3, active_client_count: 1, remote_panel_id: null, probes: [] },
  ] as unknown as Server[];
const subs = () => [{ id: 1, name: 'Маша', country: 'ru', server_ids: [1], peer_count: 1 }] as unknown as Subscriber[];
const props = { selected: null, onSelect: vi.fn(), onOpenMap: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  create.mockImplementation(() => sceneApi);
});

it('обновление данных без изменений не перестраивает город', () => {
  const { rerender } = render(<TopologyCity servers={makeServers()} bridges={[] as Bridge[]} subscribers={subs()} {...props} />);
  expect(sceneApi.update).toHaveBeenCalledTimes(1);
  // Новый опрос — новые массивы с теми же данными
  rerender(<TopologyCity servers={makeServers()} bridges={[] as Bridge[]} subscribers={subs()} {...props} />);
  expect(sceneApi.update).toHaveBeenCalledTimes(1);
  // Изменились данные — город перестраивается
  const changed = makeServers();
  changed[1] = { ...changed[1], status: 'offline' } as Server;
  rerender(<TopologyCity servers={changed} bridges={[] as Bridge[]} subscribers={subs()} {...props} />);
  expect(sceneApi.update).toHaveBeenCalledTimes(2);
});

it('сцена не создалась (WebGL отказал) — показывается запасной экран', async () => {
  create.mockImplementation(() => { throw new Error('context lost'); });
  render(<TopologyCity servers={makeServers()} bridges={[] as Bridge[]} subscribers={subs()} {...props} />);
  expect(await screen.findByText('3D недоступно в этом браузере')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Открыть карту' })).toBeInTheDocument();
});

it('выбор, которого нет в городе, не передаётся сцене', () => {
  render(
    <TopologyCity servers={makeServers()} bridges={[] as Bridge[]} subscribers={subs()} {...props} selected={{ kind: 'country', id: 'DE' }} />
  );
  expect(sceneApi.setSelected).toHaveBeenLastCalledWith(null);
});
