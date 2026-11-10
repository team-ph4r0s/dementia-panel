import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentationView } from './DocumentationView';
import { guideSections } from './documentation';
import { Navbar } from './Navbar';
import type { AdminUser } from '../types';

vi.mock('../api', () => ({
  api: {
    getVersion: vi.fn().mockResolvedValue({ current: 'v0.0.0', check_enabled: false, update_available: false }),
  },
}));

it('показывает оглавление и ищет кнопки по нескольким словам без учёта регистра', () => {
  render(<DocumentationView />);
  expect(screen.getByRole('link', { name: 'Мосты' })).toHaveAttribute('href', '#guide-bridges');
  const search = screen.getByRole('searchbox', { name: 'Поиск по документации' });
  fireEvent.change(search, { target: { value: 'ЗАПАСНЫЕ порты' } });
  expect(screen.getByText('Запасные порты', { selector: 'summary' })).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Мосты' })).toBeNull();
  fireEvent.change(search, { target: { value: 'несуществующая кнопка' } });
  expect(screen.getByRole('status')).toHaveTextContent('Совпадений нет');
});

describe('Покрытие документации разделами и элементами панели', () => {
  it('у каждого раздела панели из основного nav есть соответствующая секция в guideSections с непустыми entries', () => {
    const admin: AdminUser = { id: 1, username: 'admin', role: 'admin' };
    const props = {
      servers: [],
      bridges: [],
      subscribers: [],
      user: admin,
      readOnly: false,
      live: 'ws' as const,
      activeTab: 'servers' as const,
      onSelectTab: vi.fn(),
      onAddServer: vi.fn(),
      onAddSubscriber: vi.fn(),
      onOpenAccount: vi.fn(),
      onLogout: vi.fn(),
    };

    render(<Navbar {...props} />);
    const nav = screen.getByRole('navigation', { name: 'Разделы панели' });
    const tabButtons = within(nav).getAllByRole('button');
    const tabLabels = tabButtons.map((b) => b.textContent?.trim() ?? '').filter(Boolean);

    // Явное соответствие подписи вкладки -> ID секции документации
    // «Серверы» -> topology (в документации серверы также дополняются секцией clients)
    const TAB_TO_SECTION_ID: Record<string, string> = {
      'Серверы': 'topology',
      'Мосты': 'bridges',
      'Провайдеры': 'providers',
      'Пользователи и подписки': 'subscribers',
      'Оформление подписки': 'subscription',
      'Партнёры': 'partners',
      'События': 'events',
      'Безопасность': 'security',
      'Документация': 'panel',
    };

    expect(tabLabels.length).toBeGreaterThan(0);

    for (const label of tabLabels) {
      const expectedSectionId = TAB_TO_SECTION_ID[label];
      expect(
        expectedSectionId,
        `Для новой вкладки "${label}" в Navbar требуется осознанное сопоставление с секцией документации в TAB_TO_SECTION_ID`
      ).toBeDefined();

      const section = guideSections.find((s) => s.id === expectedSectionId);
      expect(section, `Секция "${expectedSectionId}" для вкладки "${label}" должна существовать в guideSections`).toBeDefined();
      expect(section!.entries.length, `Секция "${expectedSectionId}" не должна иметь пустой список entries`).toBeGreaterThan(0);
    }
  });

  it('ID всех секций уникальны, а подписи пунктов внутри каждой секции не повторяются (без учёта пробелов и регистра)', () => {
    const sectionIds = new Set<string>();

    for (const section of guideSections) {
      expect(sectionIds.has(section.id), `ID секции "${section.id}" не уникален`).toBe(false);
      sectionIds.add(section.id);

      const labelsSeen = new Set<string>();
      for (const [rawLabel] of section.entries) {
        const normalized = rawLabel.trim().toLowerCase();
        expect(
          labelsSeen.has(normalized),
          `В секции "${section.id}" (${section.title}) дублируется подпись пункта: "${rawLabel}"`
        ).toBe(false);
        labelsSeen.add(normalized);
      }
    }
  });
});
