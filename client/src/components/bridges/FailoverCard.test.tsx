import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { FailoverStatus } from '../../types';
import { FeedbackProvider } from '../ui/Feedback';
import { FailoverCard } from './FailoverCard';
import { api } from '../../api';

vi.mock('../../api', () => ({
  api: { getFailover: vi.fn(), configureFailover: vi.fn(), disableFailover: vi.fn() },
}));

const base: FailoverStatus = {
  enabled: false, domain: '', url: null, port: 3001, include_panel: true, origin_ip: '203.0.113.200', published: [], desired: [],
  error: null, token_saved: true, email: 'admin@example.com',
  bridges: [{ id: 1, name: 'Москва', host: '198.51.100.80', status: 'online', panel_forward: true, ipv4: true }],
};

describe('FailoverCard', () => {
  it('включает резервный домен после подтверждения и передаёт новую базу ссылок', async () => {
    vi.mocked(api.getFailover).mockResolvedValue(base);
    vi.mocked(api.configureFailover).mockResolvedValue({
      ...base, enabled: true, domain: 'sub.example.com', url: 'https://sub.example.com:3001', published: ['198.51.100.80', '203.0.113.200'],
    });
    const onChanged = vi.fn();
    render(<FeedbackProvider><FailoverCard refreshKey={0} onChanged={onChanged} /></FeedbackProvider>);

    const domain = await screen.findByLabelText(/Домен/);
    const enable = screen.getByRole('button', { name: 'Включить резервный домен' });
    expect(enable).toBeDisabled();
    fireEvent.change(domain, { target: { value: ' sub.example.com ' } });
    fireEvent.click(screen.getByLabelText('Прямой IP панели в DNS'));
    fireEvent.click(enable);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));

    await waitFor(() => expect(api.configureFailover).toHaveBeenCalledWith({ domain: 'sub.example.com', include_panel: false }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('https://sub.example.com:3001'));
    expect(await screen.findByText('198.51.100.80, 203.0.113.200')).toBeInTheDocument();
  });

  it('предупреждает, если ни один мост не пересылает панель', async () => {
    vi.mocked(api.getFailover).mockResolvedValue({ ...base, bridges: [{ ...base.bridges[0], panel_forward: false }] });
    render(<FeedbackProvider><FailoverCard refreshKey={0} onChanged={vi.fn()} /></FeedbackProvider>);
    expect(await screen.findByText(/Ни на одном мосту не включена/)).toBeInTheDocument();
  });
});
