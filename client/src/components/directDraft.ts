import type { DirectRouting } from '../types';

export interface DirectDraft {
  enabled: boolean;
  awg: boolean;
  countries: string[];
  domains: string;
  cidrs: string;
}

export function toDraft(direct: DirectRouting): DirectDraft {
  return { enabled: direct.enabled, awg: direct.awg, countries: direct.countries, domains: direct.domains.join('\n'), cidrs: direct.cidrs.join('\n') };
}
