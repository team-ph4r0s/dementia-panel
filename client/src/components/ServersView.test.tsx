import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Bridge, Server, Subscriber } from '../types';
import { FeedbackProvider } from './ui/Feedback';
import { ServersView } from './ServersView';
import { AddServerModal } from './AddServerModal';
import { VlessParamsModal } from './VlessParamsModal';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    createServer: vi.fn(),
    updateServer: vi.fn(),
    randomizeParams: vi.fn(),
    enableCdn: vi.fn(),
    disableCdn: vi.fn(),
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
  const onEditParams = vi.fn();
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
        onEditParams={onEditParams}
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
  return { onSelectServer, onEditParams };
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

  it('кнопка «Город» открывает 3D-город и запоминает выбор', async () => {
    window.localStorage.clear();
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Город' }));
    expect(await screen.findByRole('region', { name: 'Город сети' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Карта сети/)).toBeNull();
    expect(window.localStorage.getItem('dementia.servers.view.v1')).toBe('city');
    expect(screen.getByRole('button', { name: 'Город' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('сохранённый режим «Город» восстанавливается; выбор в городе открывает инспектор', async () => {
    window.localStorage.setItem('dementia.servers.view.v1', 'city');
    const { onSelectServer } = setup();
    const city = await screen.findByRole('region', { name: 'Город сети' });
    fireEvent.click(within(city).getByRole('button', { name: /node-2/ }));
    expect(onSelectServer).toHaveBeenCalledWith(2);
    expect(within(screen.getByTestId('inspector')).getByRole('heading', { name: 'node-2' })).toBeInTheDocument();
    // Без WebGL город предлагает 2D-карту
    fireEvent.click(within(city).getByRole('button', { name: 'Открыть карту' }));
    expect(screen.getByLabelText(/^Карта сети/)).toBeInTheDocument();
    window.localStorage.clear();
  });

  it('выбранная в городе нода удалена — инспектор показывает сводку', async () => {
    window.localStorage.setItem('dementia.servers.view.v1', 'city');
    const props = {
      bridges: [bridge], subscribers, clients: [], selectedServerId: 2, onSelectServer: vi.fn(), onInstallServer: vi.fn(), onEditParams: vi.fn(),
      onServerDeleted: vi.fn(), onEditServer: vi.fn(), onServerChanged: vi.fn(), onAddClient: vi.fn(), onShowQr: vi.fn(),
      onClientUpdated: vi.fn(), onClientDeleted: vi.fn(), onOpenBridges: vi.fn(),
    };
    const { rerender } = render(<FeedbackProvider><ServersView servers={[server(1), server(2)]} {...props} /></FeedbackProvider>);
    const city = await screen.findByRole('region', { name: 'Город сети' });
    fireEvent.click(within(city).getByRole('button', { name: /node-2/ }));
    expect(within(screen.getByTestId('inspector')).getByRole('heading', { name: 'node-2' })).toBeInTheDocument();
    rerender(<FeedbackProvider><ServersView servers={[server(1)]} {...props} /></FeedbackProvider>);
    expect(screen.getByTestId('inspector')).toHaveTextContent('Состояние сети');
    window.localStorage.clear();
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

describe('VLESS Reality', () => {
  const node = server(1, {
    protocol: 'vless', awg_port: 443, status: 'uninstalled', awg_version: 1, latest_awg_version: 3,
    reality_sni: 'www.microsoft.com', reality_dest: 'www.microsoft.com:443', reality_short_ids: ['abcd'],
    xray_flow: 'xtls-rprx-vision', xray_fingerprint: 'chrome',
  });

  it.each([
    { protocol: 'awg', port: 51820, label: 'Порт протокола (UDP)' },
    { protocol: 'vless', port: 443, label: 'Порт (TCP)' },
  ])('передаёт протокол $protocol при создании ноды', async ({ protocol, port, label }) => {
    vi.mocked(api.createServer).mockClear().mockResolvedValueOnce(node);
    const onServerAdded = vi.fn();
    render(
      <FeedbackProvider>
        <AddServerModal isOpen onClose={vi.fn()} onServerAdded={onServerAdded} />
      </FeedbackProvider>,
    );
    fireEvent.change(screen.getByLabelText('Протокол'), { target: { value: protocol } });
    expect(screen.getByLabelText(label)).toHaveValue(port);
    if (protocol === 'vless') {
      expect(screen.queryByText('Подсеть клиентов')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Из AmneziaVPN/ })).not.toBeInTheDocument();
    }
    fireEvent.change(screen.getByPlaceholderText('например: Frankfurt-01'), { target: { value: 'node' } });
    fireEvent.change(screen.getByPlaceholderText('194.87.12.34'), { target: { value: '203.0.113.10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить сервер' }));
    expect(api.createServer).toHaveBeenCalledWith(expect.objectContaining({ protocol, awg_port: port }));
    expect(vi.mocked(api.createServer).mock.lastCall?.[0].subnet).toBe(protocol === 'awg' ? '10.8.0.1/24' : undefined);
    await waitFor(() => expect(onServerAdded).toHaveBeenCalledWith(node));
  });

  it('показывает Reality и TCP в инспекторе ноды, скрывает действия AmneziaWG', () => {
    window.localStorage.clear();
    const { onEditParams } = setup([node]);
    click(screen.getByRole('button', { name: /Нода node-1/ }));
    const inspector = within(screen.getByTestId('inspector'));
    expect(inspector.getByText('VLESS', { exact: true })).toBeInTheDocument();
    expect(inspector.getByText('443/tcp')).toBeInTheDocument();
    expect(inspector.getByText('www.microsoft.com')).toBeInTheDocument();
    expect(inspector.getByRole('button', { name: 'Установить VLESS Reality' })).toBeInTheDocument();
    for (const name of [/Перейти на/, /Сканировать/, /Параметры AWG/]) {
      expect(inspector.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    fireEvent.click(inspector.getByRole('button', { name: 'Параметры Reality' }));
    expect(onEditParams).toHaveBeenCalledWith(node);
  });

  it('подставляет сгенерированные параметры и сохраняет shortId массивом', async () => {
    vi.mocked(api.randomizeParams).mockResolvedValueOnce({ ...node, reality_short_ids: ['1234'] });
    vi.mocked(api.updateServer).mockResolvedValueOnce(node);
    const onClose = vi.fn();
    render(
      <FeedbackProvider>
        <VlessParamsModal server={node} onClose={onClose} onUpdated={vi.fn()} />
      </FeedbackProvider>,
    );
    const shortIds = screen.getByLabelText(/shortId/);
    expect(shortIds).toHaveValue('abcd');
    fireEvent.click(screen.getByRole('button', { name: 'Сгенерировать новые' }));
    expect(api.randomizeParams).toHaveBeenCalledWith(node.id);
    await waitFor(() => expect(shortIds).toHaveValue('1234'));
    fireEvent.change(shortIds, { target: { value: ' 1234, ABCD ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(api.updateServer).toHaveBeenCalledWith(node.id, {
      reality_sni: 'www.microsoft.com',
      reality_dest: 'www.microsoft.com:443',
      reality_short_ids: ['1234', 'abcd'],
      xray_flow: 'xtls-rprx-vision',
      xray_fingerprint: 'chrome',
      xray_transport: 'tcp',
      xhttp_path: '/',
      xhttp_mode: 'auto',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('сохраняет транспорт XHTTP и включает вход через CDN после подтверждения', async () => {
    vi.mocked(api.updateServer).mockResolvedValueOnce(node);
    vi.mocked(api.enableCdn).mockResolvedValueOnce({ ...node, cdn_enabled: true, cdn_domain: 'vpn.example.com', cdn_port: 8443 });
    const onUpdated = vi.fn();
    render(
      <FeedbackProvider>
        <VlessParamsModal server={{ ...node, xhttp_path: '/abc' }} onClose={vi.fn()} onUpdated={onUpdated} />
      </FeedbackProvider>,
    );
    // Порт VLESS ноды (443) не предлагается для входа через CDN
    const port = screen.getByLabelText('Порт');
    expect(within(port).queryByRole('option', { name: '443' })).not.toBeInTheDocument();
    expect(port).toHaveValue('8443');

    const enable = screen.getByRole('button', { name: 'Включить вход через CDN' });
    expect(enable).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Домен/), { target: { value: ' vpn.example.com ' } });
    fireEvent.change(screen.getByLabelText(/Адрес для подключения/), { target: { value: '104.16.1.1' } });
    fireEvent.click(enable);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(api.enableCdn).toHaveBeenCalledWith(node.id, { domain: 'vpn.example.com', port: 8443, address: '104.16.1.1' }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ cdn_enabled: true })));
    expect(await screen.findByText('включён')).toBeInTheDocument();
  });
});
