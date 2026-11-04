import React, { useState } from 'react';
import {
  Server as ServerIcon,
  Play,
  Settings2,
  RefreshCw,
  Trash2,
  KeyRound,
  Shield,
  Pencil,
  AlertTriangle,
  Zap,
  ScanSearch,
  ArrowUpCircle,
} from 'lucide-react';
import type { Server } from '../types';
import { api } from '../api';
import { ProbeBadges } from './ProbeBadges';
import { useFeedback } from './ui/feedback-context';

interface NodeDetailsProps {
  server: Server;
  onInstallServer: (server: Server) => void;
  onEditParams: (server: Server) => void;
  onServerDeleted: (id: number) => void;
  onEditServer: (server: Server) => void;
  onServerChanged: () => void;
}

const STATUS_LABELS: Record<Server['status'], string> = {
  online: 'AmneziaWG активен',
  installing: 'Идёт установка',
  offline: 'Недоступен',
  error: 'Ошибка',
  uninstalled: 'Не установлен',
};

const STATUS_CLASS: Record<Server['status'], string> = {
  online: 'bg-ok-soft text-ok',
  installing: 'bg-warn-soft text-warn',
  error: 'bg-bad-soft text-bad',
  offline: 'bg-bad-soft text-bad',
  uninstalled: 'bg-soft text-muted',
};

const actionButton =
  'flex items-center gap-1.5 bg-soft hover:bg-soft-2 text-ink text-xs font-medium px-3 py-2 rounded-lg border border-line transition disabled:opacity-50';

/**
 * Карточка выбранной ноды: состояние, действия (установка, SSH, синхронизация, настройки, удаление), предупреждения и параметры
 * обфускации. Живёт в инспекторе справа от карты и в режиме «Список».
 */
export const NodeDetails: React.FC<NodeDetailsProps> = ({
  server,
  onInstallServer,
  onEditParams,
  onServerDeleted,
  onEditServer,
  onServerChanged,
}) => {
  const { toast, confirm, alert: showAlert } = useFeedback();
  const [busy, setBusy] = useState<'ssh' | 'sync' | 'scan' | 'apply' | 'upgrade' | null>(null);

  const run = async (kind: NonNullable<typeof busy>, task: () => Promise<void>, refresh = true) => {
    setBusy(kind);
    try {
      await task();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(null);
      if (refresh) onServerChanged();
    }
  };

  const handleScan = () =>
    run('scan', async () => {
      const res = await api.scanServer(server.id);
      await showAlert(res.message, 'Результат сканирования');
    });

  const handleUpgrade = async () => {
    const ok = await confirm({
      title: `Перейти на AmneziaWG ${server.latest_awg_version}.x?`,
      message:
        `Нода «${server.name}»: будут сгенерированы параметры актуальной версии, AmneziaWG переустановлен с последним образом (клиенты сохраняются). ` +
        'Все пользователи должны обновить подписку или конфигурацию.',
      confirmLabel: 'Обновить',
    });
    if (!ok) return;
    await run('upgrade', async () => {
      const res = await api.upgradeProtocol(server.id);
      if (res.success) toast('Сервер переведён на актуальную версию AmneziaWG.', 'success');
      else toast(`Ошибка переустановки: ${res.error}`, 'error');
    });
  };

  const handleTestSsh = () =>
    run(
      'ssh',
      async () => {
        const res = await api.testSsh(server.id);
        toast(res.message ?? 'SSH-подключение работает', 'success');
      },
      false
    );

  const handleSync = () =>
    run('sync', async () => {
      const res = await api.syncServer(server.id);
      if (res.success) toast('Пиры успешно синхронизированы на сервере', 'success');
      else toast(`Ошибка синхронизации: ${res.error}`, 'error');
    });

  const handleApply = () =>
    run('apply', async () => {
      const res = await api.applyServer(server.id);
      if (res.success) toast('Параметры применены, AmneziaWG перезапущен', 'success');
      else toast(`Ошибка применения: ${res.error}`, 'error');
    });

  const handleDelete = async () => {
    if (!(await confirm({ title: 'Удалить сервер?', message: `Удалить сервер "${server.name}" из панели вместе со всеми его клиентами?`, danger: true, confirmLabel: 'Удалить' }))) return;
    const teardown =
      server.status !== 'uninstalled' &&
      (await confirm({
        title: 'Остановить AmneziaWG на сервере?',
        message:
          'Остановить и удалить AmneziaWG на самом сервере?\n\n' +
          '«Остановить» — VPN на сервере будет отключён.\n' +
          '«Только из панели» — удалить только из панели (VPN на сервере продолжит работать для всех выданных конфигов).',
        danger: true,
        confirmLabel: 'Остановить',
        cancelLabel: 'Только из панели',
      }));
    try {
      await api.deleteServer(server.id, { teardown });
      onServerDeleted(server.id);
    } catch (err: any) {
      if (teardown && (await confirm({ message: `${err.message}\n\nУдалить сервер из панели принудительно?`, danger: true, confirmLabel: 'Удалить принудительно' }))) {
        try {
          await api.deleteServer(server.id, { force: true });
          onServerDeleted(server.id);
        } catch (e: any) {
          toast(e.message, 'error');
        }
      } else {
        toast(err.message, 'error');
      }
    }
  };

  const partner = server.remote_panel_id !== null;

  return (
    <div className="space-y-4">
      {/* Заголовок */}
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-soft border border-line flex items-center justify-center flex-shrink-0">
          <ServerIcon className="w-5 h-5 text-brand" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-bold text-ink tracking-tight break-all">{server.name}</h2>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_CLASS[server.status]}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              {STATUS_LABELS[server.status]}
            </span>
          </div>
          <div className="text-xs text-muted mt-0.5 font-mono break-all">{server.host}</div>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        {[
          ['SSH', String(server.ssh_port)],
          ['AWG', `${server.awg_port}/udp`],
          ['Подсеть', server.subnet],
          ['Версия', `${server.awg_version >= 3 ? '3' : '1'}.x`],
        ].map(([label, value]) => (
          <div key={label} className="bg-paper border border-line rounded-lg px-3 py-2">
            <dt className="text-faint">{label}</dt>
            <dd className="font-mono text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      {server.probes && server.probes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Из стран:</span>
          <ProbeBadges probes={server.probes} showRtt />
        </div>
      )}

      {/* Действия */}
      <div className="flex flex-wrap items-center gap-2">
        {partner ? (
          <span className="text-xs text-warn bg-warn-soft border border-line px-3 py-2 rounded-lg">Нода партнёра · {server.remote_panel_name}</span>
        ) : (
          <>
            <button onClick={() => onInstallServer(server)} className="flex items-center gap-2 bg-brand text-on-accent font-bold text-xs px-3.5 py-2 rounded-lg transition btn-press">
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>{server.status === 'uninstalled' ? 'Установить AmneziaWG' : 'Переустановить'}</span>
            </button>
            <button onClick={() => onEditParams(server)} className={actionButton} title="Настроить заголовки и мусорные пакеты">
              <Settings2 className="w-3.5 h-3.5 text-brand" />
              <span>Параметры AWG</span>
            </button>
            <button onClick={handleTestSsh} disabled={busy === 'ssh'} className={actionButton} title="Проверить SSH-соединение">
              <KeyRound className="w-3.5 h-3.5 text-info" />
              <span>{busy === 'ssh' ? 'Тест...' : 'Тест SSH'}</span>
            </button>
            {(server.status === 'uninstalled' || server.status === 'error') && (
              <button onClick={handleScan} disabled={busy === 'scan'} className={actionButton} title="Найти уже установленный AmneziaWG и подключить без переустановки">
                <ScanSearch className="w-3.5 h-3.5 text-info" />
                <span>{busy === 'scan' ? 'Сканирование...' : 'Сканировать'}</span>
              </button>
            )}
            <button onClick={() => onEditServer(server)} className={actionButton} title="Хост, SSH-доступ, порт">
              <Pencil className="w-3.5 h-3.5" />
              <span>Настройки</span>
            </button>
          </>
        )}

        {server.status !== 'uninstalled' && server.status !== 'installing' && (
          <button onClick={handleSync} disabled={busy === 'sync'} className={actionButton} title="Синхронизировать конфигурацию на сервере">
            <RefreshCw className={`w-3.5 h-3.5 text-ok ${busy === 'sync' ? 'animate-spin' : ''}`} />
            <span>Синхронизация</span>
          </button>
        )}

        {!partner && (
          <button onClick={handleDelete} className="p-2 text-faint hover:text-bad hover:bg-soft rounded-lg transition border border-line" title="Удалить сервер" aria-label="Удалить сервер">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Предупреждения и заметки */}
      {(server.needs_apply || server.needs_sync || server.last_error) && server.status !== 'uninstalled' && (
        <div className="bg-warn-soft border border-line rounded-xl p-3 flex flex-wrap items-start justify-between gap-3 text-xs">
          <div className="flex items-start gap-2 text-warn min-w-0">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0">
              {server.needs_apply && <p>Параметры интерфейса изменены, но ещё не применены на сервере.</p>}
              {server.needs_sync && !server.needs_apply && <p>Изменения клиентов ещё не доставлены на сервер — панель повторит попытку автоматически.</p>}
              {server.last_error && <p className="break-all">Последняя ошибка: {server.last_error}</p>}
            </div>
          </div>
          {server.needs_apply && (
            <button onClick={handleApply} disabled={busy === 'apply'} className="flex items-center gap-1.5 bg-warn-soft text-warn font-medium px-3 py-1.5 rounded-lg border border-warn/30 transition disabled:opacity-50">
              <Zap className="w-3.5 h-3.5" />
              <span>{busy === 'apply' ? 'Применение...' : 'Применить сейчас'}</span>
            </button>
          )}
        </div>
      )}

      {partner && (
        <div className="bg-paper border border-line rounded-xl p-3 text-xs text-muted">
          Нода предоставлена панелью партнёра «{server.remote_panel_name}». Параметры, установку и обновления выполняет владелец; вы можете
          создавать на ней клиентов и выдавать её своим пользователям. Владелец видит ваших клиентов и может их заблокировать.
          {server.status === 'uninstalled' && server.last_error && <span className="block text-warn mt-1">{server.last_error}</span>}
        </div>
      )}

      {!partner && server.awg_version < server.latest_awg_version && (
        <div className="bg-info-soft border border-line rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="text-info">
            Используются параметры обфускации устаревшего AmneziaWG 1.x. Актуальная версия — {server.latest_awg_version}.x (S3/S4, диапазоны заголовков, защита заголовков).
          </span>
          <button onClick={handleUpgrade} disabled={busy === 'upgrade'} className="flex items-center gap-1.5 bg-info-soft text-info font-medium px-3 py-1.5 rounded-lg border border-info/30 transition disabled:opacity-50">
            <ArrowUpCircle className="w-3.5 h-3.5" />
            <span>{busy === 'upgrade' ? 'Обновление...' : `Перейти на ${server.latest_awg_version}.x`}</span>
          </button>
        </div>
      )}

      {server.managed_by === 'amnezia' && (
        <div className="bg-paper border border-line rounded-xl p-3 text-xs text-muted">
          Подключён контейнер приложения Amnezia (<span className="font-mono">{server.container_name}</span>). Управляйте клиентами только из панели:
          изменения в приложении Amnezia будут перезаписаны при синхронизации. Смена порта или «Переустановить» заменит его контейнером панели с теми же ключами и клиентами.
        </div>
      )}

      {!partner && server.status !== 'uninstalled' && (
        <div className="bg-paper border border-line rounded-xl p-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
          <span className="font-medium text-ink">ПО ноды:</span>
          {server.node_info_at ? (
            <>
              <span>
                amneziawg-go <strong className="font-mono text-ink">{server.node_awg_go || '—'}</strong>
              </span>
              <span>
                {server.node_awg_tools?.split(' ')[0] || 'утилиты'} <strong className="font-mono text-ink">{server.node_awg_tools?.split(' ')[1] || '—'}</strong>
              </span>
              {server.node_image && (
                <span title="Образ контейнера AmneziaWG и дата его сборки. Свежий образ ставится при переустановке">
                  образ <span className="font-mono text-ink break-all">{server.node_image}</span>
                  {server.node_image_created && <> от {new Date(server.node_image_created).toLocaleDateString('ru-RU')}</>}
                </span>
              )}
            </>
          ) : (
            <span className="text-faint">версии будут получены при следующем опросе ноды</span>
          )}
        </div>
      )}

      {!partner && server.node_update?.available === 1 && (
        <p className="text-xs text-warn">Доступно обновление AmneziaWG — запустите его в разделе «Обновления AmneziaWG».</p>
      )}

      <div className="bg-paper border border-line rounded-xl p-3 space-y-2 text-xs">
        <div className="flex items-center gap-2 text-muted">
          <Shield className="w-4 h-4 text-brand" />
          <span className="font-medium text-ink">Параметры AmneziaWG</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono">
          <span className="px-2 py-0.5 rounded bg-card border border-line text-ink">
            Jc: <strong className="text-brand">{server.jc}</strong>
          </span>
          <span className="px-2 py-0.5 rounded bg-card border border-line text-ink">
            Junk: <strong className="text-brand">{server.jmin}-{server.jmax}B</strong>
          </span>
          <span className="px-2 py-0.5 rounded bg-card border border-line text-ink">
            S1–S{server.s3 !== null ? 4 : 2}:{' '}
            <strong className="text-info">{[server.s1, server.s2, server.s3, server.s4].filter((v) => v !== null).join('/')}B</strong>
          </span>
          <span className="px-2 py-0.5 rounded bg-card border border-line text-ink">
            H1-H4: <strong className="text-accent">{server.h1.includes('-') ? 'диапазоны' : 'значения'}</strong>
          </span>
          {server.header_protection_key && (
            <span className="px-2 py-0.5 rounded bg-card border border-line text-ink">
              <strong className="text-warn">Защита заголовков</strong>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
