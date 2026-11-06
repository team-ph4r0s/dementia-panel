import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { FeedbackProvider } from '../ui/Feedback';
import { PanelIpCard } from './PanelIpCard';
import { api } from '../../api';

vi.mock('../../api', () => ({ api: { getPanelIp: vi.fn(), applyPanelIp: vi.fn(), setPanelIpAuto: vi.fn() } }));

const changed = {
  known: '203.0.113.5', detected: '198.51.100.77', changed: true, auto: false, checked_at: null,
  uses: { cloudflare_domain: 'panel.example.com', bridges: 2, failover_domain: 'sub.example.com', public_url_by_ip: false },
};

describe('PanelIpCard', () => {
  it('показывает обнаруженную смену, подставляет новый адрес и применяет его после подтверждения', async () => {
    vi.mocked(api.getPanelIp).mockResolvedValue(changed);
    vi.mocked(api.applyPanelIp).mockResolvedValue({ ip: changed.detected, previous: changed.known, steps: [{ ok: true, title: 'DNS panel.example.com', detail: 'ok' }] });
    render(<FeedbackProvider><PanelIpCard /></FeedbackProvider>);

    expect(await screen.findByRole('alert')).toHaveTextContent('198.51.100.77');
    expect(screen.getByText(/A-запись домена panel.example.com/)).toBeInTheDocument();
    expect(screen.getByLabelText('Новый IPv4 панели')).toHaveValue('198.51.100.77');

    fireEvent.click(screen.getByRole('button', { name: 'Обновить везде' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Обновить везде' }));
    await waitFor(() => expect(api.applyPanelIp).toHaveBeenCalledWith('198.51.100.77'));
  });

  it('автообновление включается флажком', async () => {
    vi.mocked(api.getPanelIp).mockResolvedValue({ ...changed, changed: false, detected: null });
    vi.mocked(api.setPanelIpAuto).mockResolvedValue({ ...changed, changed: false, detected: null, auto: true });
    render(<FeedbackProvider><PanelIpCard /></FeedbackProvider>);
    fireEvent.click(await screen.findByLabelText(/Обновлять автоматически/));
    await waitFor(() => expect(api.setPanelIpAuto).toHaveBeenCalledWith(true));
  });
});
