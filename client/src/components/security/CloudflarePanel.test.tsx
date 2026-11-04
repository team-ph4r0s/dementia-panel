import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api } from '../../api';
import { CloudflareTab } from './CloudflareTab';
import { CloudflarePanelCard } from './CloudflarePanelCard';
import { FeedbackProvider } from '../ui/Feedback';

vi.mock('../../api', () => ({ api: { verifyCloudflareToken: vi.fn(), getCloudflareZones: vi.fn(), issueLetsEncryptCf: vi.fn(),
  getCloudflarePanel: vi.fn(), configureCloudflarePanel: vi.fn(), disableCloudflarePanel: vi.fn() } }));
vi.mock('./https', () => ({ HTTPS_SWITCH_NOTE: '', switchToHttps: vi.fn() }));
const status = { enabled: false, domain: '', origin_ip: '', port: 443, url: null, token_saved: true, email: 'a@example.com',
  listener_ready: false, error: null, https_ports: [443, 8443] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCloudflarePanel).mockResolvedValue(status);
  vi.mocked(api.verifyCloudflareToken).mockResolvedValue({ valid: true, message: 'OK' });
  vi.mocked(api.getCloudflareZones).mockResolvedValue([{ id: 'a', name: 'example.com' }]);
  vi.mocked(api.issueLetsEncryptCf).mockResolvedValue({ success: true });
  vi.mocked(api.configureCloudflarePanel).mockResolvedValue({ ...status, enabled: true, domain: 'panel.example.com', url: 'https://panel.example.com', origin_ip: '203.0.113.9' });
});
describe('сохранённый токен и домен Cloudflare', () => {
  it('показывает сохранённый токен для HTTPS и позволяет проверить его без ввода секрета', async () => {
    render(<CloudflareTab sslStatus={{ enabled: true, hasCert: true, domain: 'panel.example.com', mode: 'letsencrypt_cf', expiresAt: null,
      autoRenew: true, cfTokenSaved: true, email: 'a@example.com' }} setMessage={vi.fn()} onReload={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Токен Cloudflare сохранён');
    expect(screen.getByLabelText('API токен Cloudflare для сертификата')).toHaveValue('');
    expect(screen.getByLabelText('API токен Cloudflare для сертификата')).not.toBeRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    await waitFor(() => expect(api.verifyCloudflareToken).toHaveBeenCalledWith(''));
    fireEvent.click(screen.getByRole('button', { name: /Выпустить сертификат/ }));
    await waitFor(() => expect(api.issueLetsEncryptCf).toHaveBeenCalledWith({ domain: 'panel.example.com', email: 'a@example.com', token: '', createARecord: true }));
  });
  it('без сохранённого токена поле обязательно и кнопка выпуска недоступна', () => {
    render(<CloudflareTab setMessage={vi.fn()} onReload={vi.fn()} />);
    expect(screen.getByLabelText('API токен Cloudflare для сертификата')).toBeRequired();
    expect(screen.getByRole('button', { name: /Выпустить сертификат/ })).toBeDisabled();
  });
  it('создаёт проксируемый домен только после подтверждения, повторно используя сохранённый токен', async () => {
    const changed = vi.fn();
    render(<FeedbackProvider><CloudflarePanelCard onChanged={changed} /></FeedbackProvider>);
    await screen.findByText(/Токен Cloudflare уже сохранён/);
    expect(screen.getByText(/Full \(strict\)/)).toBeInTheDocument();
    expect(screen.getByText(/VPN продолжит работать напрямую/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Отдельный домен панели'), { target: { value: 'panel.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Настроить домен и включить проксирование' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.configureCloudflarePanel).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Настроить домен' }));
    await waitFor(() => expect(api.configureCloudflarePanel).toHaveBeenCalledWith({ domain: 'panel.example.com', token: '', origin_ip: '', email: 'a@example.com', port: 443 }));
    expect(await screen.findByRole('link', { name: 'https://panel.example.com' })).toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
  });
});
