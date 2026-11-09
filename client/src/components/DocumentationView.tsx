import { BookOpen, ChevronDown, Search } from 'lucide-react';
import { useState } from 'react';
import { guideSections } from './documentation';

export function DocumentationView() {
  const [query, setQuery] = useState('');
  const words = query.toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
  const sections = guideSections.map((section) => ({
    ...section,
    entries: section.entries.filter(([label, description]) => {
      const text = `${section.title} ${label} ${description}`.toLocaleLowerCase('ru');
      return words.every((word) => text.includes(word));
    }),
  })).filter((section) => section.entries.length > 0);

  return (
    <section aria-labelledby="guide-title" className="space-y-5" data-guest-ok>
      <div className="bg-card border border-line rounded-2xl p-5 sm:p-6 space-y-4">
        <div className="flex items-start gap-3">
          <BookOpen className="mt-1 w-5 h-5 shrink-0 text-brand" aria-hidden="true" />
          <div>
            <h1 id="guide-title" className="text-xl font-bold text-ink">Документация</h1>
            <p className="mt-1 text-sm text-muted">Найдите кнопку по названию или откройте нужный раздел панели в оглавлении.</p>
          </div>
        </div>
        <label className="relative block max-w-xl">
          <Search className="absolute left-3 top-3 w-4 h-4 text-muted" aria-hidden="true" />
          <input
            type="search"
            aria-label="Поиск по документации"
            placeholder="Например, запасные порты"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full min-h-10 rounded-lg border border-line bg-paper pl-9 pr-3 text-sm text-ink placeholder-muted focus:outline-2 focus:outline-brand"
          />
        </label>
        {sections.length > 0 && (
          <nav aria-label="Оглавление документации" className="flex flex-wrap gap-2">
            {sections.map(({ id, title }) => (
              <a key={id} href={`#guide-${id}`} className="inline-flex min-h-10 items-center rounded-lg border border-line px-3 text-xs text-brand hover:bg-soft">
                {title}
              </a>
            ))}
          </nav>
        )}
      </div>
      {sections.length === 0 && <p role="status" className="text-sm text-muted">Совпадений нет. Попробуйте другое название кнопки или функции.</p>}
      {sections.map(({ id, title, entries }) => (
        <section key={id} id={`guide-${id}`} aria-labelledby={`guide-title-${id}`} className="scroll-mt-4 bg-card border border-line rounded-2xl overflow-hidden">
          <h2 id={`guide-title-${id}`} className="px-5 py-4 text-base font-semibold text-ink border-b border-line">{title}</h2>
          <div className="divide-y divide-line">
            {entries.map(([label, description]) => (
              <details key={label} className="group">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm font-medium text-ink hover:bg-soft [&::-webkit-details-marker]:hidden">
                  {label}
                  <ChevronDown aria-hidden="true" className="w-4 h-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
                </summary>
                <p className="max-w-4xl px-5 pb-4 text-sm leading-relaxed text-muted">{description}</p>
              </details>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
