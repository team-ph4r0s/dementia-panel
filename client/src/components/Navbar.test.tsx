import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { AdminUser } from '../types';
import { Navbar } from './Navbar';
import { SubscribersList } from './SubscribersList';
import { FeedbackProvider } from './ui/Feedback';

vi.mock('../api', () => ({
  api: {
    getVersion: vi.fn().mockResolvedValue({ current: 'v0.0.0', check_enabled: false, update_available: false }),
    updateSubscriber: vi.fn(),
  },
}));

const admin = { id: 1, username: 'demo', role: 'admin' } as AdminUser;

function setup(readOnly = false) {
  const props = {
    servers: [], bridges: [], subscribers: [], live: 'ws' as const, user: admin, activeTab: 'servers' as const, readOnly,
    onSelectTab: vi.fn(), onAddServer: vi.fn(), onAddSubscriber: vi.fn(), onOpenAccount: vi.fn(), onLogout: vi.fn(),
  };
  render(<Navbar {...props} />);
  return props;
}

describe('Navbar: боковое меню разделов на телефоне', () => {
  it('кнопка меню открывает панель с разделами; выбор раздела переключает его и закрывает меню', () => {
    const props = setup();
    const toggle = screen.getByRole('button', { name: 'Меню разделов' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    const drawer = screen.getByRole('dialog', { name: 'Меню разделов' });
    const nav = within(drawer).getByRole('navigation', { name: 'Разделы панели (меню)' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Серверы', 'Мосты', 'Провайдеры', 'Пользователи и подписки', 'Оформление подписки', 'Партнёры', 'События', 'Безопасность', 'Документация',
    ]);
    expect(within(nav).getByRole('button', { name: 'Серверы' })).toHaveAttribute('aria-current', 'page');
    // Сводка сети и учётная запись — тоже в меню
    expect(within(drawer).getByLabelText('Сводка сети')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /Учётная запись/ })).toBeInTheDocument();

    fireEvent.click(within(nav).getByRole('button', { name: 'Мосты' }));
    expect(props.onSelectTab).toHaveBeenCalledWith('bridges');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('закрывается по Esc, крестику и тапу по затемнению', () => {
    setup();
    const toggle = screen.getByRole('button', { name: 'Меню разделов' });

    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть меню' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('учётная запись из меню открывает окно и закрывает меню; выход доступен', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Меню разделов' }));
    fireEvent.click(screen.getByRole('button', { name: /Учётная запись demo/ }));
    expect(props.onOpenAccount).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Меню разделов' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Выйти' }));
    expect(props.onLogout).toHaveBeenCalled();
  });

  it('у гостя в меню нет разделов настройки и учётной записи', () => {
    setup(true);
    fireEvent.click(screen.getByRole('button', { name: 'Меню разделов' }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).queryByRole('button', { name: 'Безопасность' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Оформление подписки' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /Учётная запись/ })).toBeNull();
    expect(within(drawer).getByRole('button', { name: 'Документация' })).toBeEnabled();
  });

  it('главное действие раздела в шапке подписано для скринридера', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить: Нода' }));
    expect(props.onAddServer).toHaveBeenCalled();
  });
});

describe('SubscribersList на телефоне', () => {
  it('карточки пользователей с подпиской и действиями (таблица — для широкого экрана)', () => {
    const onShow = vi.fn();
    const sub = {
      id: 7, name: 'Иван', enabled: 1, suspended: false, expired: false, country: 'ru', traffic_limit: 0, traffic_used: 0, total_rx: 0, total_tx: 2048,
      expire_at: null, servers: [{ id: 1, name: 'Нидерланды' }],
    } as any;
    render(
      <FeedbackProvider>
        <SubscribersList subscribers={[sub]} onAddSubscriber={vi.fn()} onEditSubscriber={vi.fn()} onShowSubscription={onShow} onSubscriberUpdated={vi.fn()} onSubscriberDeleted={vi.fn()} />
      </FeedbackProvider>,
    );
    const cards = screen.getByRole('list', { name: 'Пользователи' });
    const card = within(cards).getByRole('listitem');
    expect(within(card).getByText('Иван')).toBeInTheDocument();
    expect(within(card).getByText('Нидерланды')).toBeInTheDocument();
    expect(within(card).getByText('Активен')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Удалить «Иван»' })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /Подписка/ }));
    expect(onShow).toHaveBeenCalledWith(sub);
  });
});
