import { useEffect, useState } from 'react';
import { Cloud } from 'lucide-react';
import { api } from '../../api';
import type { CloudflarePanelStatus } from '../../types';
import { useFeedback } from '../ui/feedback-context';

export function CloudflarePanelCard({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<CloudflarePanelStatus | null>(null);
  const [domain, setDomain] = useState('');
  const [token, setToken] = useState('');
  const [ip, setIp] = useState('');
  const [email, setEmail] = useState('');
  const [port, setPort] = useState(443);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { toast, confirm } = useFeedback();
  useEffect(() => {
    let active = true;
    api.getCloudflarePanel().then((s) => {
      if (!active) return;
      setStatus(s); setDomain(s.domain); setIp(s.origin_ip); setEmail(s.email); setPort(s.port);
    }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  const configure = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(await confirm({ title: 'Настроить домен панели через Cloudflare?',
      message: `Для ${domain.trim()} будет создана или обновлена A-запись с проксированием. При необходимости панель выпустит сертификат и откроет отдельный HTTPS-вход на TCP-порту ${port}. Публичный адрес панели и адрес новых ссылок подписок изменятся.`,
      confirmLabel: 'Настроить домен' }))) return;
    setBusy(true); setError('');
    try {
      const result = await api.configureCloudflarePanel({ domain: domain.trim(), token: token.trim(), origin_ip: ip.trim(), email: email.trim(), port });
      setStatus(result); setToken(''); setIp(result.origin_ip);
      toast('DNS-запись настроена, проксирование включено. Проверьте новый адрес в отдельной вкладке.', 'success');
      onChanged();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    if (!(await confirm({ title: 'Отключить проксирование?', message: 'DNS-запись останется, но начнёт указывать напрямую на IP сервера. HTTPS и текущий адрес панели сохранятся.', confirmLabel: 'Отключить' }))) return;
    setBusy(true); setError('');
    try { setStatus(await api.disableCloudflarePanel()); onChanged(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const input = 'w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-brand';
  return <section className="bg-card border border-line rounded-2xl p-6 sm:p-8 space-y-4" aria-label="Домен панели через Cloudflare">
    <h2 className="flex items-center gap-2 text-lg font-bold text-ink"><Cloud className="w-5 h-5 text-warn" />Домен панели · Cloudflare</h2>
    <p className="text-xs text-muted">Оранжевое облако проксирует сайт панели, API и подписки. Для AmneziaWG оставьте IP сервера или отдельный DNS-домен без проксирования — VPN продолжит работать напрямую на том же сервере.</p>
    <div className="bg-paper border border-line rounded-xl p-3 text-xs text-muted space-y-1">
      <p>В Cloudflare выберите SSL/TLS → Full (strict). Режим Flexible не подходит. Откройте выбранный TCP-порт в фаерволе VPS и у хостинга.</p>
      <p>Порт 443 позволяет открыть домен без номера порта. Если он занят другим сайтом, выберите другой HTTPS-порт из списка. Текущий порт панели останется доступен.</p>
      <p>Для токена нужны Zone → Zone → Read и Zone → DNS → Edit на нужную DNS-зону. Настройки остальных сайтов зоны не меняются.</p>
      <p>Для API и подписок (/api, /sub) не включайте кэширование и проверки CAPTCHA: VPN-приложения не смогут их пройти.</p>
    </div>
    {status?.enabled && <p className="text-xs text-ok">Проксирование Cloudflare настроено: <a className="underline break-all" href={status.url!} target="_blank" rel="noreferrer">{status.url}</a></p>}
    {status?.token_saved && <p role="status" className="text-xs text-ok">Токен Cloudflare уже сохранён. Можно использовать его без повторного ввода.</p>}
    {(error || status?.error) && <p role="alert" className="text-xs text-bad">{error || status?.error}</p>}
    <form onSubmit={configure} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="space-y-1 text-xs text-muted block">Отдельный домен панели<input className={input} required placeholder="panel.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} /></label>
        <label className="space-y-1 text-xs text-muted block">API токен Cloudflare<input className={input} type="password" autoComplete="new-password" required={!status?.token_saved} placeholder={status?.token_saved ? 'Сохранён — оставьте пустым' : 'Токен с доступом к DNS-зоне'} value={token} onChange={(e) => setToken(e.target.value)} /></label>
        <label className="space-y-1 text-xs text-muted block">IPv4 сервера панели<input className={input} placeholder="Определить автоматически" value={ip} onChange={(e) => setIp(e.target.value)} /></label>
        <label className="space-y-1 text-xs text-muted block">Email Let’s Encrypt<input className={input} type="email" placeholder="Для выпуска сертификата, если его ещё нет" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="space-y-1 text-xs text-muted block">HTTPS-порт<select className={input} value={port} onChange={(e) => setPort(Number(e.target.value))}>{(status?.https_ports ?? [443, 2053, 2083, 2087, 2096, 8443]).map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !status} className="bg-brand text-on-accent font-semibold text-xs px-4 py-2.5 rounded-lg btn-press disabled:opacity-50">{busy ? 'Настройка…' : 'Настроить домен и включить проксирование'}</button>
        {status?.enabled && <button type="button" disabled={busy} onClick={disable} className="bg-soft text-ink border border-line text-xs px-4 py-2.5 rounded-lg disabled:opacity-50">Отключить проксирование</button>}
      </div>
    </form>
  </section>;
}
