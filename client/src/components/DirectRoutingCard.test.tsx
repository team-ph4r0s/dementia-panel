import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DirectRoutingCard } from './DirectRoutingCard';
import type { DirectDraft } from './directDraft';

let last: DirectDraft;
function Harness({ initial }: { initial: DirectDraft }) {
  const [draft, setDraft] = useState(initial);
  last = draft;
  return <DirectRoutingCard draft={draft} status={[{ country: 'ru', networks: 1200, updated_at: null }]} onChange={setDraft} onRefresh={vi.fn()} />;
}
const empty: DirectDraft = { enabled: false, awg: false, countries: [], domains: '', cidrs: '' };

describe('«Напрямую, мимо VPN»', () => {
  it('добавляет страну из списка и по коду, убирает и не дублирует', () => {
    render(<Harness initial={empty} />);
    fireEvent.change(screen.getByLabelText('Добавить страну'), { target: { value: 'ru' } });
    expect(last.countries).toEqual(['ru']);
    fireEvent.change(screen.getByLabelText('Код другой страны'), { target: { value: 'DE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(last.countries).toEqual(['ru', 'de']);
    fireEvent.change(screen.getByLabelText('Код другой страны'), { target: { value: 'ru' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(last.countries).toEqual(['ru', 'de']);
    fireEvent.click(screen.getByLabelText(/Убрать страну/, { selector: '[aria-label$="Россия"]' }));
    expect(last.countries).toEqual(['de']);
  });

  it('список сетей показывается только при включённом AmneziaWG', () => {
    render(<Harness initial={{ ...empty, countries: ['ru'] }} />);
    expect(screen.queryByText('1200')).toBeNull();
    fireEvent.click(screen.getByLabelText(/Применять к конфигам AmneziaWG/));
    expect(screen.getByText('1200')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Обновить списки сетей/ })).toBeInTheDocument();
  });
});
