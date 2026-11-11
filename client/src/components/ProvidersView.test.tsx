import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProvidersView } from './ProvidersView';
import { api } from '../api';
import type { ProviderItem, ProvidersData } from '../types';

vi.mock('../api', () => ({
  api: {
    getProviders: vi.fn(),
    saveProvider: vi.fn(),
    getProviderPassword: vi.fn(),
    saveProviderSettings: vi.fn(),
  },
}));

const item = (patch: Partial<ProviderItem> = {}): ProviderItem => ({
  target_type: 'node', target_id: 1, name: 'Нода Хельсинки', host: '192.0.2.50', country: null,
  url: null, login: null, password_saved: false, amount: null, currency: 'RUB', pay_day: null, pay_month: null,
  next_due: null, days_left: null, ...patch,
});

const data = (items: ProviderItem[], telegram_ready = true): ProvidersData => ({
  items, telegram_ready, settings: { remind_enabled: true, remind_days: [1, 0], remind_hour: 6 },
});

describe('ProvidersView', () => {
  it('показывает карточку на каждый сервер и предупреждает, что Telegram не настроен', async () => {
    vi.mocked(api.getProviders).mockResolvedValue(data([item({ target_type: 'panel', target_id: 0, name: 'Панель', host: null }), item()], false));
    render(<ProvidersView />);
    expect(await screen.findByRole('article', { name: 'Панель' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Нода Хельсинки' })).toBeInTheDocument();
    expect(screen.getByText(/Telegram не настроен или выключен/)).toBeInTheDocument();
  });

  it('сохраняет введённые данные; пароль уходит, только если его меняли', async () => {
    vi.mocked(api.getProviders).mockResolvedValue(data([item()]));
    vi.mocked(api.saveProvider).mockResolvedValue([item({ login: 'me', amount: 500, pay_day: 15, next_due: '2026-11-15', days_left: 1 })]);
    render(<ProvidersView />);
    const card = await screen.findByRole('article', { name: 'Нода Хельсинки' });
    const save = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.includes('Сохранить'))!;
    expect(save).toBeDisabled();

    const get = (label: string) => card.querySelector<HTMLInputElement>(`[id$="${label}"]`)!;
    fireEvent.change(get('-login'), { target: { value: 'me' } });
    fireEvent.change(get('-amount'), { target: { value: '500' } });
    fireEvent.change(get('-day'), { target: { value: '15' } });
    fireEvent.click(save);

    await waitFor(() => expect(api.saveProvider).toHaveBeenCalledTimes(1));
    const [type, id, body] = vi.mocked(api.saveProvider).mock.calls[0];
    expect(type).toBe('node');
    expect(id).toBe(1);
    expect(body).toMatchObject({ login: 'me', amount: '500', pay_day: '15', pay_month: '', currency: 'RUB' });
    expect(body).not.toHaveProperty('password');
    expect(await screen.findByText(/Платёж: завтра, 15 ноября/)).toBeInTheDocument();
  });

  it('просмотр сохранённого пароля не помечает карточку изменённой и не отправляет пароль (#89)', async () => {
    vi.mocked(api.saveProvider).mockReset();
    vi.mocked(api.getProviders).mockResolvedValue(data([item({ login: 'me', password_saved: true })]));
    vi.mocked(api.getProviderPassword).mockResolvedValue('old-secret');
    vi.mocked(api.saveProvider).mockResolvedValue([item({ login: 'me2', password_saved: true })]);
    render(<ProvidersView />);
    const card = await screen.findByRole('article', { name: 'Нода Хельсинки' });
    const save = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.includes('Сохранить'))!;
    const field = card.querySelector<HTMLInputElement>('[id$="-password"]')!;

    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
    await waitFor(() => expect(field.value).toBe('old-secret'));
    expect(field.type).toBe('text');
    expect(save).toBeDisabled();

    // Другая правка: пароль, который только просматривали, в запрос не попадает
    fireEvent.change(card.querySelector<HTMLInputElement>('[id$="-login"]')!, { target: { value: 'me2' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.saveProvider).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveProvider).mock.calls[0][2]).not.toHaveProperty('password');
  });

  it('изменённый после просмотра пароль отправляется', async () => {
    vi.mocked(api.saveProvider).mockReset();
    vi.mocked(api.getProviders).mockResolvedValue(data([item({ password_saved: true })]));
    vi.mocked(api.getProviderPassword).mockResolvedValue('old-secret');
    vi.mocked(api.saveProvider).mockResolvedValue([item({ password_saved: true })]);
    render(<ProvidersView />);
    const card = await screen.findByRole('article', { name: 'Нода Хельсинки' });
    const field = card.querySelector<HTMLInputElement>('[id$="-password"]')!;
    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
    await waitFor(() => expect(field.value).toBe('old-secret'));
    fireEvent.change(field, { target: { value: 'new-secret' } });
    fireEvent.click(Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.includes('Сохранить'))!);
    await waitFor(() => expect(api.saveProvider).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveProvider).mock.calls[0][2]).toMatchObject({ password: 'new-secret' });
  });
});
