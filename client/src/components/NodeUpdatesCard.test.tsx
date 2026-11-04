import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import { NodeUpdatesCard } from './NodeUpdatesCard';
import { FeedbackProvider } from './ui/Feedback';

vi.mock('../api', () => ({ api: { getNodeUpdates: vi.fn(), saveNodeUpdateSettings: vi.fn(), startNodeUpdates: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getNodeUpdates).mockResolvedValue({ settings: { auto_update: false, hour_utc: 3 }, running: false, active_server: null,
    nodes: [{ server_id: 1, name: 'Берлин', available: 1, current_image: 'old', latest_image: 'new', checked_at: null, attempted_at: null, updated_at: null, result: 'available', error: null }] });
  vi.mocked(api.startNodeUpdates).mockResolvedValue({ started: true });
  vi.mocked(api.saveNodeUpdateSettings).mockImplementation(async (s) => s);
});
function setup() { render(<FeedbackProvider><NodeUpdatesCard onChanged={vi.fn()} /></FeedbackProvider>); }
describe('обновления нод', () => {
  it('показывает доступную ноду и сохраняет явное включение расписания UTC', async () => {
    setup();
    expect(await screen.findByText('Берлин: доступно обновление')).toBeInTheDocument();
    expect(screen.getByLabelText('Автообновление')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Автообновление'));
    fireEvent.change(screen.getByLabelText('Час автообновления UTC'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить расписание' }));
    await waitFor(() => expect(api.saveNodeUpdateSettings).toHaveBeenCalledWith({ auto_update: true, hour_utc: 5 }));
  });
  it('не запускает массовое обновление до подтверждения перерыва VPN и сохранения клиентов', async () => {
    setup(); await screen.findByText('Берлин: доступно обновление');
    fireEvent.click(screen.getByRole('button', { name: 'Обновить все' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('ключи и клиенты сохранятся');
    expect(api.startNodeUpdates).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Обновить все' }).at(-1)!);
    await waitFor(() => expect(api.startNodeUpdates).toHaveBeenCalledWith('update'));
  });
});
