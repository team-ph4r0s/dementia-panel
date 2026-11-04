import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { Bridge, Server, Subscriber } from '../types';
import { FeedbackProvider } from './ui/Feedback';
import { ServersView } from './ServersView';

vi.mock('../api', () => ({
  api: {
    getNodeUpdates: vi.fn().mockResolvedValue({ settings: { auto_update: false, hour_utc: 3 }, running: false, active_server: null, nodes: [] }),
    getProbes: vi.fn().mockResolvedValue({
      settings: { enabled: false, countries: [], interval_minutes: 30, show_in_name: false, show_in_description: false },
      status: { running: false, last_run: null, error: null, next_run: null },
      max_countries: 5, servers: [], results: [],
    }),
    getProbeCountries: vi.fn().mockResolvedValue([]),
  },
}));

const server = (id: number, patch: Partial<Server> = {}): Server =>
  ({
    id, name: `node-${id}`, host: `10.0.0.${id}`, ssh_port: 22, awg_port: 51820, subnet: '10.8.0.0/24', status: 'online', awg_version: 3,
    latest_awg_version: 3, remote_panel_id: null, remote_panel_name: null, needs_sync: false, needs_apply: false, last_error: null,
    client_count: 4, active_client_count: 2, probes: [], jc: 5, jmin: 50, jmax: 1000, s1: 1, s2: 2, s3: null, s4: null, h1: '1', h2: '2', h3: '3', h4: '4',
    header_protection_key: null, managed_by: 'demension', container_name: 'amnezia-awg', node_info_at: null, ...patch,
  }) as Server;

const bridge = { id: 1, name: 'bridge-ru', host: '1.2.3.4', country: 'ru', status: 'online', needs_apply: false, last_error: null, links: [{ server_id: 1, server_name: 'node-1', mode: 'auto', active: true, check_ok: true, listen_port: 30001, awg_port: 51820 }] } as unknown as Bridge;
const subscribers = [{ id: 1, name: 'Маша', country: 'ru', server_ids: [1], peer_count: 1, enabled: 1, suspended: false }] as unknown as Subscriber[];

function setup(servers = [server(1), server(2, { status: 'offline', last_error: 'timeout' })]) {
  const onSelectServer = vi.fn();
  render(
    <FeedbackProvider>
      <ServersView
        servers={servers}
        bridges={[bridge]}
        subscribers={subscribers}
        clients={[]}
        selectedServerId={servers[0]?.id ?? null}
        onSelectServer={onSelectServer}
        onInstallServer={vi.fn()}
        onEditParams={vi.fn()}
        onServerDeleted={vi.fn()}
        onEditServer={vi.fn()}
        onServerChanged={vi.fn()}
        onAddClient={vi.fn()}
        onShowQr={vi.fn()}
        onClientUpdated={vi.fn()}
        onClientDeleted={vi.fn()}
        onOpenBridges={vi.fn()}
      />
    </FeedbackProvider>
  );
  return { onSelectServer };
}

const click = (el: Element) => {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 5, clientY: 5 });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 5, clientY: 5 });
};

describe('ServersView', () => {
  it('по умолчанию показывает карту со всеми объектами и сводку сети справа', () => {
    window.localStorage.clear();
    setup();
    expect(screen.getByLabelText(/^Карта сети/)).toBeInTheDocument();
    for (const name of [/Нода node-1/, /Нода node-2/, /Мост bridge-ru/, /Страна RU/]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByTestId('inspector')).toHaveTextContent('Состояние сети');
    expect(screen.getByTestId('inspector')).toHaveTextContent('node-2: нет связи');
  });

  it('клик по ноде открывает её карточку и сообщает App о выборе; Esc возвращает сводку', () => {
    const { onSelectServer } = setup();
    click(screen.getByRole('button', { name: /Нода node-2/ }));
    expect(onSelectServer).toHaveBeenCalledWith(2);
    const inspector = screen.getByTestId('inspector');
    expect(within(inspector).getByRole('heading', { name: 'node-2' })).toBeInTheDocument();
    expect(inspector).toHaveTextContent('Последняя ошибка: timeout');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('inspector')).toHaveTextContent('Состояние сети');
  });

  it('мост и страна открывают свои инспекторы', () => {
    setup();
    click(screen.getByRole('button', { name: /Мост bridge-ru/ }));
    expect(within(screen.getByTestId('inspector')).getByRole('heading', { name: 'bridge-ru' })).toBeInTheDocument();
    expect(screen.getByTestId('inspector')).toHaveTextContent('выдаётся пользователям');
    click(screen.getByRole('button', { name: /Страна RU/ }));
    expect(screen.getByTestId('inspector')).toHaveTextContent('Маша');
  });

  it('узлы доступны с клавиатуры: Enter выбирает', () => {
    setup();
    const node = screen.getByRole('button', { name: /Нода node-1/ });
    node.focus();
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(within(screen.getByTestId('inspector')).getByRole('heading', { name: 'node-1' })).toBeInTheDocument();
  });

  it('переключатель переводит в режим «Список» и запоминает выбор', () => {
    window.localStorage.clear();
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Список' }));
    expect(screen.queryByLabelText(/^Карта сети/)).toBeNull();
    expect(screen.getByRole('button', { name: /node-1/ })).toBeInTheDocument();
    expect(window.localStorage.getItem('dementia.servers.view.v1')).toBe('list');
  });

  it('слои «мосты» и «страны» скрывают соответствующие узлы', () => {
    window.localStorage.clear();
    setup();
    fireEvent.click(screen.getByLabelText('мосты'));
    expect(screen.queryByRole('button', { name: /Мост bridge-ru/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('страны'));
    expect(screen.queryByRole('button', { name: /Страна RU/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Нода node-1/ })).toBeInTheDocument();
  });
});
