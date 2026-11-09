import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DocumentationView } from './DocumentationView';

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
