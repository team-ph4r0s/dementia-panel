import { useState, type FormEvent } from 'react';
import { Cloud, Loader2, Search, Shuffle, X } from 'lucide-react';
import { api } from '../api';
import type { Server } from '../types';
import { useFeedback } from './ui/feedback-context';
import { ModalShell } from './ui/Modal';

interface VlessParamsModalProps {
  server: Server;
  onClose: () => void;
  onUpdated: (server: Server) => void;
}

const title = 'Параметры Reality';
const warning = 'После изменения параметров пользователям нужно обновить подписку или заново импортировать ссылку VLESS.';
const fingerprints = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'];
const xhttpModes = ['auto', 'packet-up', 'stream-up', 'stream-one'] as const;
/** HTTPS-порты, которые Cloudflare проксирует на ноду */
const cdnPorts = [443, 2053, 2083, 2087, 2096, 8443];
const inputClass = 'mt-1 w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm font-mono text-ink focus:border-brand';

function toForm(server: Server) {
  return {
    sni: server.reality_sni ?? '',
    dest: server.reality_dest ?? '',
    shortIds: server.reality_short_ids?.join(', ') ?? '',
    flow: server.xray_flow ?? 'xtls-rprx-vision',
    fingerprint: server.xray_fingerprint ?? 'chrome',
    transport: server.xray_transport ?? 'tcp',
    path: server.xhttp_path ?? '/',
    mode: server.xhttp_mode ?? 'auto',
  };
}

function toCdnForm(server: Server) {
  const free = cdnPorts.filter((port) => port !== server.awg_port);
  return {
    domain: server.cdn_domain ?? '',
    port: server.cdn_port && free.includes(server.cdn_port) ? server.cdn_port : free.includes(8443) ? 8443 : free[0],
    address: server.cdn_address ?? '',
    token: '',
    email: '',
  };
}

export function VlessParamsModal({ server, onClose, onUpdated }: VlessParamsModalProps) {
  const { confirm, toast } = useFeedback();
  const [form, setForm] = useState(() => toForm(server));
  const [busy, setBusy] = useState(false);
  const [cdn, setCdn] = useState(() => toCdnForm(server));
  const [current, setCurrent] = useState(server);
  const [probing, setProbing] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<{ domain: string; latency_ms: number | null; suitable: boolean }[] | null>(null);

  const pickCandidate = (domain: string) => {
    setForm((prev) => ({
      ...prev,
      sni: domain,
      dest: `${domain}:443`,
    }));
  };

  const probeCandidates = async () => {
    setProbing(true);
    setCandidatesError(null);
    try {
      const extraDomain = form.sni.trim() || undefined;
      const res = await api.realityCandidates(current.id, extraDomain);
      setCandidates(res.candidates);
    } catch (err) {
      setCandidatesError(err instanceof Error ? err.message : 'Не удалось проверить сайты маскировки');
    } finally {
      setProbing(false);
    }
  };

  const update = async (request: () => Promise<Server>, randomize = false) => {
    setBusy(true);
    try {
      if (server.status !== 'uninstalled' && !(await confirm({
        title: randomize ? 'Сгенерировать параметры Reality?' : 'Сохранить параметры Reality?',
        message: warning,
      }))) return;
      const updated = await request();
      onUpdated(updated);
      if (randomize) setForm(toForm(updated));
      else onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось изменить параметры Reality', 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void update(() => api.updateServer(server.id, {
      reality_sni: form.sni.trim(),
      reality_dest: form.dest.trim(),
      reality_short_ids: form.shortIds.split(',').map((id) => id.trim().toLowerCase()),
      xray_flow: form.flow,
      xray_fingerprint: form.fingerprint,
      xray_transport: form.transport,
      xhttp_path: form.path.trim(),
      xhttp_mode: form.mode,
    }));
  };

  const enableCdn = async () => {
    setBusy(true);
    try {
      if (!(await confirm({
        title: current.cdn_enabled ? 'Обновить вход через CDN?' : 'Включить вход через CDN?',
        message: `Панель выпустит сертификат для ${cdn.domain || 'домена'}, создаст в Cloudflare A-запись с оранжевым облаком на IP ноды и переустановит контейнер Xray (соединения переподключатся). В подписках появится запись «· CDN».`,
      }))) return;
      const updated = await api.enableCdn(current.id, {
        domain: cdn.domain.trim(),
        port: cdn.port,
        address: cdn.address.trim(),
        ...(cdn.token.trim() ? { token: cdn.token.trim() } : {}),
        ...(cdn.email.trim() ? { email: cdn.email.trim() } : {}),
      });
      setCurrent(updated);
      setCdn({ ...toCdnForm(updated) });
      onUpdated(updated);
      toast('Вход через CDN включён', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось включить вход через CDN', 'error');
    } finally {
      setBusy(false);
    }
  };

  const disableCdn = async () => {
    setBusy(true);
    try {
      if (!(await confirm({
        title: 'Выключить вход через CDN?',
        message: 'Запись «· CDN» пропадёт из подписок, A-запись в Cloudflare будет удалена. Сертификат сохранится для повторного включения.',
      }))) return;
      const { warning: notice, ...updated } = await api.disableCdn(current.id);
      setCurrent(updated);
      onUpdated(updated);
      toast(notice ?? 'Вход через CDN выключен', notice ? 'error' : 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось выключить вход через CDN', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell label={title} onClose={onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-lg shadow-pop overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-line">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            <p className="text-xs text-muted break-all">{server.name} ({server.host})</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="p-1 text-muted hover:text-ink rounded-lg hover:bg-soft border border-line">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={save} className="p-6 overflow-y-auto">
          <fieldset disabled={busy} className="space-y-4 min-w-0 disabled:opacity-50">
            <p className="p-3 bg-warn-soft text-warn rounded-lg text-xs">{warning}</p>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink">Сайт маскировки Reality</span>
              <button
                type="button"
                onClick={probeCandidates}
                disabled={probing || busy}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border border-line bg-card hover:bg-soft text-ink disabled:opacity-50 transition"
                title="Проверить доступность сайтов-кандидатов (TLS 1.3, HTTP/2) с сервера ноды"
              >
                {probing ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> : <Search className="w-3.5 h-3.5 text-muted" />}
                <span>{probing ? 'Подбор...' : 'Подобрать'}</span>
              </button>
            </div>

            {candidatesError && (
              <div className="p-3 bg-bad-soft border border-line text-bad text-xs rounded-lg">
                {candidatesError}
              </div>
            )}

            {candidates && candidates.length > 0 && (
              <div className="space-y-1.5 p-3 bg-paper border border-line rounded-xl">
                <div className="text-xs text-muted font-medium mb-1">Кандидаты маскировки (проверка с ноды):</div>
                <div className="divide-y divide-line text-xs">
                  {candidates.map((c) => {
                    const isSelected = form.sni === c.domain;
                    return (
                      <div
                        key={c.domain}
                        className="py-1.5 flex flex-wrap items-center justify-between gap-2"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-mono text-ink font-medium break-all">{c.domain}</span>
                          <span className="ml-2 font-mono text-faint">
                            {c.latency_ms !== null ? `${c.latency_ms} мс` : '—'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                              c.suitable ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'
                            }`}
                          >
                            {c.suitable ? 'Подходит' : 'Не подходит'}
                          </span>
                          {c.suitable && (
                            <button
                              type="button"
                              onClick={() => pickCandidate(c.domain)}
                              className={`px-2 py-0.5 rounded text-xs transition border ${
                                isSelected
                                  ? 'bg-brand text-on-accent border-brand font-medium'
                                  : 'bg-card text-ink border-line hover:bg-soft'
                              }`}
                            >
                              {isSelected ? 'Выбран' : 'Выбрать'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <label className="block text-xs text-muted">
              SNI
              <input required value={form.sni} onChange={(e) => setForm({ ...form, sni: e.target.value })} className={inputClass} />
            </label>
            <label className="block text-xs text-muted">
              Адрес маскировки (домен:порт)
              <input required value={form.dest} onChange={(e) => setForm({ ...form, dest: e.target.value })} className={inputClass} />
            </label>
            <label className="block text-xs text-muted">
              shortId (через запятую)
              <input value={form.shortIds} onChange={(e) => setForm({ ...form, shortIds: e.target.value })} className={inputClass} aria-describedby="reality-short-id-hint" />
            </label>
            <p id="reality-short-id-hint" className="text-xs text-muted">
              От 1 до 8 значений, до 16 шестнадцатеричных символов чётной длины. Пустое значение тоже допустимо. Клиенты получают первый shortId.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                Flow
                <select value={form.flow} onChange={(e) => setForm({ ...form, flow: e.target.value === '' ? '' : 'xtls-rprx-vision' })} className={inputClass}>
                  <option value="xtls-rprx-vision">xtls-rprx-vision</option>
                  <option value="">Без flow</option>
                </select>
              </label>
              <label className="text-xs text-muted">
                Отпечаток TLS
                <select value={form.fingerprint} onChange={(e) => setForm({ ...form, fingerprint: e.target.value })} className={inputClass}>
                  {fingerprints.map((fingerprint) => <option key={fingerprint}>{fingerprint}</option>)}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                Транспорт
                <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value === 'xhttp' ? 'xhttp' : 'tcp' })} className={inputClass}>
                  <option value="tcp">TCP (RAW)</option>
                  <option value="xhttp">XHTTP</option>
                </select>
              </label>
              <label className="text-xs text-muted">
                Режим XHTTP
                <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as typeof form.mode })} className={inputClass}>
                  {xhttpModes.map((mode) => <option key={mode}>{mode}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-xs text-muted">
              Путь XHTTP
              <input value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} className={inputClass} aria-describedby="xhttp-hint" />
            </label>
            <p id="xhttp-hint" className="text-xs text-muted">
              XHTTP передаёт данные HTTP-запросами — устойчивее к анализу потока, чем TCP, но медленнее. Путь и режим общие с входом
              через CDN. Flow (Vision) с XHTTP не используется. Нужны свежие клиенты (Xray 25+, mihomo 1.19+).
            </p>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-line">
              <button
                type="button"
                onClick={() => void update(() => api.randomizeParams(server.id), true)}
                className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-ink bg-soft hover:bg-soft-2 rounded-lg btn-press border border-line"
              >
                <Shuffle className="w-3.5 h-3.5 text-brand" />
                Сгенерировать новые
              </button>
              <button type="submit" className="bg-brand text-on-accent font-bold text-sm px-4 py-2 rounded-lg btn-press">
                Сохранить
              </button>
            </div>
          </fieldset>
        </form>

        <section aria-labelledby="cdn-title" className="px-6 pb-6 overflow-y-auto">
          <fieldset disabled={busy} className="space-y-3 min-w-0 pt-4 border-t border-line disabled:opacity-50">
            <h3 id="cdn-title" className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Cloud className="w-4 h-4 text-brand" />
              Вход через CDN Cloudflare
              {current.cdn_enabled && <span className="ml-auto px-2 py-0.5 rounded-lg text-xs bg-ok-soft text-ok">включён</span>}
            </h3>
            <p className="text-xs text-muted">
              Если IP ноды заблокирован, клиенты подключаются к адресам Cloudflare, а он пересылает трафик на ноду (VLESS + XHTTP + TLS).
              Нужен домен в Cloudflare и токен с правами Zone:Read и DNS:Edit; режим SSL/TLS зоны — Full (strict).
              Там, где режут сам Cloudflare, этот вход не поможет.
            </p>
            {current.cdn_error && <p className="p-3 bg-bad-soft text-bad rounded-lg text-xs">{current.cdn_error}</p>}
            {current.cdn_enabled && current.cdn_expires_at && (
              <p className="text-xs text-muted">
                Сертификат до <span className="font-mono text-ink">{new Date(current.cdn_expires_at).toLocaleDateString('ru-RU')}</span>, продлевается автоматически.
              </p>
            )}
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <label className="text-xs text-muted">
                Домен (поддомен с оранжевым облаком)
                <input value={cdn.domain} onChange={(e) => setCdn({ ...cdn, domain: e.target.value })} placeholder="vpn.example.com" className={inputClass} />
              </label>
              <label className="text-xs text-muted">
                Порт
                <select value={cdn.port} onChange={(e) => setCdn({ ...cdn, port: Number(e.target.value) })} className={inputClass}>
                  {cdnPorts.filter((port) => port !== current.awg_port).map((port) => <option key={port} value={port}>{port}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-xs text-muted">
              Адрес для подключения (необязательно)
              <input value={cdn.address} onChange={(e) => setCdn({ ...cdn, address: e.target.value })} placeholder="домен или «чистый» IP Cloudflare" className={inputClass} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                Токен Cloudflare
                <input type="password" autoComplete="off" value={cdn.token} onChange={(e) => setCdn({ ...cdn, token: e.target.value })} placeholder="если не сохранён" className={inputClass} />
              </label>
              <label className="text-xs text-muted">
                Email Let’s Encrypt
                <input type="email" value={cdn.email} onChange={(e) => setCdn({ ...cdn, email: e.target.value })} placeholder="если не сохранён" className={inputClass} />
              </label>
            </div>
            <div className="flex flex-wrap justify-end gap-3">
              {current.cdn_enabled && (
                <button type="button" onClick={() => void disableCdn()} className="px-3 py-2 text-xs font-medium text-bad bg-soft hover:bg-soft-2 rounded-lg btn-press border border-line">
                  Выключить
                </button>
              )}
              <button
                type="button"
                disabled={!cdn.domain.trim()}
                onClick={() => void enableCdn()}
                className="bg-brand text-on-accent font-bold text-sm px-4 py-2 rounded-lg btn-press disabled:opacity-50"
              >
                {current.cdn_enabled ? 'Обновить вход через CDN' : 'Включить вход через CDN'}
              </button>
            </div>
          </fieldset>
        </section>
      </div>
    </ModalShell>
  );
}
