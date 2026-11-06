import type { NodeProtocol } from '../types';

export function ProtocolBadge({ protocol }: { protocol: NodeProtocol }) {
  const vless = protocol === 'vless';
  return (
    <span className={`rounded-full px-2 py-0.5 font-mono text-xs font-semibold ${vless ? 'bg-info-soft text-info' : 'bg-soft text-muted'}`}>
      {vless ? 'VLESS' : 'AWG'}
    </span>
  );
}
