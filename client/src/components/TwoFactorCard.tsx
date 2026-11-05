import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api';

const inputClass = 'w-full bg-paper border border-line rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-brand';

export const TwoFactorCard: React.FC = () => {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setError('');
    setLoading(true);
    try { await action(); } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-ink"><ShieldCheck className="w-4 h-4 text-ok" />Двухфакторная аутентификация</div>
      <p className="text-xs text-muted">Добавьте код из приложения-аутентификатора ко входу в панель.</p>
      {error && <div className="p-3 bg-bad-soft rounded-xl text-bad text-xs">{error}</div>}
      {recoveryCodes.length > 0 && (
        <div className="p-3 bg-paper border border-line rounded-xl">
          <p className="text-xs text-muted mb-2">Сохраните коды восстановления. Они показываются только один раз.</p>
          <div className="grid grid-cols-2 gap-2 font-mono text-sm text-ink">{recoveryCodes.map((item) => <code key={item}>{item}</code>)}</div>
        </div>
      )}
      {!setup ? (
        <button type="button" disabled={loading} onClick={() => run(async () => setSetup(await api.setupTotp()))} className="bg-brand text-on-accent px-4 py-2 rounded-lg text-sm font-bold btn-press disabled:opacity-50">Настроить 2FA</button>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const result = await api.enableTotp(setup.secret, code, password); setRecoveryCodes(result.recovery_codes); setSetup(null); setCode(''); }); }} className="space-y-3">
          <div className="p-3 bg-paper border border-line rounded-xl break-all">
            <p className="text-xs text-muted mb-1">Добавьте этот секрет в приложение-аутентификатор:</p>
            <code className="text-sm text-ink">{setup.secret}</code>
            <p className="text-xs text-faint mt-2">{setup.uri}</p>
          </div>
          <input aria-label="Код из приложения" required inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className={inputClass} placeholder="Код из приложения" />
          <input aria-label="Пароль для включения 2FA" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="Текущий пароль" />
          <button disabled={loading} className="bg-brand text-on-accent px-4 py-2 rounded-lg text-sm font-bold btn-press disabled:opacity-50">Включить 2FA</button>
        </form>
      )}
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.disableTotp(password); setPassword(''); setRecoveryCodes([]); }); }} className="pt-3 border-t border-line space-y-2">
        <label className="block text-xs text-muted">Пароль для отключения или перевыпуска кодов</label>
        <input aria-label="Пароль для 2FA" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        <div className="flex gap-2">
          <button disabled={loading} className="px-3 py-2 rounded-full bg-bad-soft text-bad text-xs">Отключить 2FA</button>
          <button type="button" disabled={loading} onClick={() => run(async () => { const result = await api.rotateRecoveryCodes(password); setRecoveryCodes(result.recovery_codes); setPassword(''); })} className="px-3 py-2 rounded-full bg-soft text-ink text-xs">Перевыпустить коды</button>
        </div>
      </form>
    </div>
  );
};
