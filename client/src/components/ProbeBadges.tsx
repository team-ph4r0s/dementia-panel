import React from 'react';
import type { ProbeResult } from '../types';
import { countryFlag, countryName } from '../utils';

const MARK: Record<ProbeResult['status'], { symbol: string; label: string; className: string }> = {
  ok: { symbol: '✓', label: 'доступна', className: 'text-ok' },
  partial: { symbol: '!', label: 'доступна не со всех узлов страны', className: 'text-warn' },
  fail: { symbol: '✕', label: 'недоступна', className: 'text-bad' },
};

function details(p: ProbeResult): string {
  const parts = [`${p.ok_nodes} из ${p.total_nodes} узлов`];
  if (p.method === 'stub' && p.verified) {
    parts.push(p.udp_ok !== null ? `UDP дошёл с ${p.udp_ok}` : 'UDP: нет данных');
    if (p.tcp_ok !== null) parts.push(`TCP — с ${p.tcp_ok}`);
    if (p.spoofed > 0) parts.push(`подменённых ответов: ${p.spoofed}`);
  } else if (p.method === 'stub') {
    parts.push('журнал ноды не прочитан — без подтверждения');
  } else {
    parts.push('TCP-порт, без подтверждения на ноде');
  }
  if (p.gp_total) parts.push(`Globalping (${p.gp_eyeball ? 'сети провайдеров' : 'дата-центры'}): ${p.gp_ok ?? 0} из ${p.gp_total}`);
  if (p.rtt_ms !== null) parts.push(`${p.rtt_ms} мс`);
  return parts.join(', ');
}

/**
 * Доступность ноды из выбранных стран: флаг и отметка. Подсказка — страна, сколько узлов дошло до ноды и задержка.
 */
export const ProbeBadges: React.FC<{ probes?: ProbeResult[]; showRtt?: boolean }> = ({ probes, showRtt }) => {
  if (!probes || probes.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {probes.map((p) => {
        const mark = MARK[p.status];
        return (
          <span
            key={p.country}
            title={`${countryName(p.country)}: ${mark.label} (${details(p)}); проверено ${new Date(p.checked_at).toLocaleString()}`}
            className="inline-flex items-center gap-0.5 text-xs bg-paper border border-line rounded-md px-1.5 py-0.5"
          >
            <span>{countryFlag(p.country)}</span>
            <span className={`font-bold ${mark.className}`}>{mark.symbol}</span>
            {p.spoofed > 0 && <span className="text-bad font-bold" title="Ответ подделан по дороге: до ноды запрос не дошёл">⚑</span>}
            {showRtt && p.rtt_ms !== null && <span className="text-faint font-mono">{p.rtt_ms} мс</span>}
          </span>
        );
      })}
    </span>
  );
};
