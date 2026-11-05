import { useId, useState } from 'react';
import { api } from '../api';
import type { Server } from '../types';
import { countryName } from '../utils';
import { CountrySelect } from './CountrySelect';
import { useFeedback } from './ui/feedback-context';

export function NodeCountry({ server, readOnly, onChanged }: { server: Server; readOnly?: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useFeedback();
  const title = useId();
  const current = server.country ? countryName(server.country) : 'Не задана';

  if (draft === null || readOnly) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">Страна на глобусе</span>
        <span className="text-ink">{current}</span>
        {!readOnly && <button type="button" onClick={() => setDraft(server.country?.toLowerCase() ?? '')} className="text-brand hover:underline">Изменить</button>}
      </div>
    );
  }

  return (
    <form aria-labelledby={title} className="space-y-2" onSubmit={async (event) => {
      event.preventDefault();
      setBusy(true);
      try {
        await api.updateServerCountry(server.id, draft || null);
        setDraft(null);
        onChanged();
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Ошибка сохранения страны', 'error');
      } finally {
        setBusy(false);
      }
    }}>
      <div id={title} className="text-xs text-muted">Страна на глобусе</div>
      <fieldset disabled={busy} className="flex flex-wrap items-center gap-2">
        <CountrySelect label="Страна на глобусе" value={draft} onChange={setDraft} emptyLabel="Без страны" className="bg-paper border border-line rounded-lg p-2 text-xs text-ink" />
        <button type="submit" className="bg-brand text-on-accent rounded-lg px-3 py-2 text-xs font-semibold">Сохранить</button>
        <button type="button" onClick={() => setDraft(null)} className="text-xs text-muted hover:text-ink">Отмена</button>
      </fieldset>
    </form>
  );
}
