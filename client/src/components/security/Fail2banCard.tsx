import React, { useState } from 'react';
import { ShieldCheck, Loader2, RefreshCw, Unlock, Ban } from 'lucide-react';
import type { Fail2banStatus } from '../../types';
import { api } from '../../api';
import { SecurityBanner, type BannerMessage } from './SecurityBanner';

export const Fail2banCard: React.FC<{ f2bStatus: Fail2banStatus | null; onReload: () => void }> = ({ f2bStatus, onReload }) => {
  const [manualBanIp, setManualBanIp] = useState('');
  const [banning, setBanning] = useState(false);
  const [f2bSettingUp, setF2bSettingUp] = useState(false);

  // Сообщение под заголовком
  const [message, setMessage] = useState<BannerMessage | null>(null);

  // Unban IP
  const handleUnban = async (ip: string) => {
    try {
      await api.unbanIp(ip);
      setMessage({ type: 'success', text: `IP ${ip} успешно разблокирован` });
      onReload();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  // Manual Ban
  const handleManualBan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualBanIp.trim()) return;
    setBanning(true);
    try {
      await api.banIp(manualBanIp.trim());
      setMessage({ type: 'success', text: `IP ${manualBanIp} заблокирован` });
      setManualBanIp('');
      onReload();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBanning(false);
    }
  };

  // Setup Fail2ban
  const handleSetupFail2ban = async () => {
    setF2bSettingUp(true);
    setMessage(null);
    try {
      const res = await api.setupFail2ban();
      setMessage({ type: 'success', text: res.message });
      onReload();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setF2bSettingUp(false);
    }
  };

  return (
    <>
      <SecurityBanner message={message} onClose={() => setMessage(null)} />

      <div className="bg-card border border-line rounded-2xl p-6 sm:p-8 shadow-pop space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-line">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-info-soft border border-line flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-info" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink tracking-wide">Защита от перебора по SSH (Fail2ban)</h2>
              <p className="text-xs text-muted">
                Автоматическая блокировка злоумышленников и ботов при попытках подбора паролей к SSH
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${
                f2bStatus?.active
                  ? 'bg-ok-soft text-ok border border-line'
                  : 'bg-soft text-muted border border-line'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              {f2bStatus?.active ? 'Служба Fail2ban активна' : 'Не установлена / Не запущена'}
            </span>

            {!f2bStatus?.active && (
              <button
                onClick={handleSetupFail2ban}
                disabled={f2bSettingUp}
                className="flex items-center gap-1.5 bg-brand hover:bg-brand text-on-accent font-bold text-xs px-3.5 py-1.5 rounded-lg transition btn-press hover:text-on-accent"
              >
                {f2bSettingUp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                <span>Установить Fail2ban</span>
              </button>
            )}
          </div>
        </div>

        {/* Fail2ban Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 bg-paper border border-line rounded-2xl">
            <span className="text-xs text-faint">Неудачных попыток входа</span>
            <div className="text-2xl font-bold text-ink mt-1 font-mono">
              {f2bStatus?.totalFailed ?? 0}
            </div>
          </div>

          <div className="p-4 bg-paper border border-line rounded-2xl">
            <span className="text-xs text-faint">Всего заблокировано ботов</span>
            <div className="text-2xl font-bold text-info mt-1 font-mono">
              {f2bStatus?.totalBanned ?? 0}
            </div>
          </div>

          <div className="p-4 bg-paper border border-line rounded-2xl">
            <span className="text-xs text-faint">Активных банов (сейчас)</span>
            <div className="text-2xl font-bold text-ok mt-1 font-mono">
              {f2bStatus?.currentlyBanned?.length ?? 0}
            </div>
          </div>
        </div>

        {/* Currently Banned IPs Table */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink">
              Список заблокированных IP-адресов
            </h3>
            <button
              onClick={() => onReload()}
              className="text-xs text-muted hover:text-ink transition flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Обновить</span>
            </button>
          </div>

          {f2bStatus?.currentlyBanned && f2bStatus.currentlyBanned.length > 0 ? (
            <div className="border border-line rounded-2xl overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-paper text-muted">
                  <tr>
                    <th className="p-3 font-medium">Заблокированный IP адрес</th>
                    <th className="p-3 font-medium">Статус</th>
                    <th className="p-3 font-medium text-right">Действие</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-paper">
                  {f2bStatus.currentlyBanned.map((ip) => (
                    <tr key={ip} className="hover:bg-soft">
                      <td className="p-3 font-mono font-medium text-bad flex items-center gap-2">
                        <Ban className="w-3.5 h-3.5 text-bad" />
                        <span>{ip}</span>
                      </td>
                      <td className="p-3 text-muted">
                        Заблокирован (попытки перебора)
                      </td>
                      <td className="p-3 text-right">
                        <button
                          onClick={() => handleUnban(ip)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-soft hover:bg-soft-2 text-ink rounded-lg transition border border-line"
                        >
                          <Unlock className="w-3 h-3 text-ok" />
                          <span>Разблокировать</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-6 bg-paper border border-dashed border-line rounded-2xl text-center text-xs text-faint">
              В настоящее время нет заблокированных IP-адресов. Защита работает в штатном режиме.
            </div>
          )}
        </div>

        {/* Manual Ban Input */}
        <form onSubmit={handleManualBan} className="pt-2 flex items-center gap-3">
          <input
            type="text"
            placeholder="Заблокировать IP вручную (например: 1.2.3.4)..."
            value={manualBanIp}
            onChange={(e) => setManualBanIp(e.target.value)}
            className="flex-1 min-w-0 bg-paper border border-line rounded-xl px-3.5 py-2 text-xs text-ink font-mono focus:outline-none focus:border-brand"
          />
          <button
            type="submit"
            disabled={banning || !manualBanIp.trim()}
            className="flex items-center gap-1.5 bg-danger hover:bg-danger text-on-accent font-bold text-xs px-4 py-2 rounded-full transition disabled:opacity-50 btn-press hover:text-on-accent"
          >
            {banning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
            <span>Заблокировать</span>
          </button>
        </form>
      </div>

    </>
  );
};
