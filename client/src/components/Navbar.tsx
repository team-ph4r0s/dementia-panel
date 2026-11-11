import React, { useState } from 'react';
import { Plus, Server as ServerIcon, Users, LogOut, KeyRound, Lock, Palette, Handshake, Waypoints, ScrollText, BookOpen, Eye, Menu, X, CreditCard } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Server, Bridge, Subscriber, AdminUser } from '../types';
import { PanelVersion } from './PanelVersion';
import { BrandMark } from './BrandMark';
import { formatBytes } from '../utils';
import { InstallAppButton } from './InstallAppButton';
import { ModalShell } from './ui/Modal';

export type AppTab = 'servers' | 'bridges' | 'providers' | 'subscribers' | 'subscription' | 'partners' | 'events' | 'security' | 'docs';

/** ws — статусы приходят по WebSocket, poll — панель опрашивает сервер раз в 15 секунд */
export type LiveMode = 'ws' | 'poll';

interface NavbarProps {
  servers: Server[];
  bridges: Bridge[];
  subscribers: Subscriber[];
  user: AdminUser | null;
  /** Гостевой режим: без кнопок добавления, учётной записи и разделов настройки */
  readOnly?: boolean;
  live: LiveMode;
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onAddServer: () => void;
  onAddSubscriber: () => void;
  onOpenAccount: () => void;
  onLogout: () => void;
}

const TABS: { id: AppTab; label: string; icon: LucideIcon }[] = [
  { id: 'servers', label: 'Серверы', icon: ServerIcon },
  { id: 'bridges', label: 'Мосты', icon: Waypoints },
  { id: 'providers', label: 'Провайдеры', icon: CreditCard },
  { id: 'subscribers', label: 'Пользователи и подписки', icon: Users },
  { id: 'subscription', label: 'Оформление подписки', icon: Palette },
  { id: 'partners', label: 'Партнёры', icon: Handshake },
  { id: 'events', label: 'События', icon: ScrollText },
  { id: 'security', label: 'Безопасность', icon: Lock },
  { id: 'docs', label: 'Документация', icon: BookOpen },
];

/** Разделы, доступные гостю (настройки подписки и безопасности скрыты) */
const GUEST_TABS: AppTab[] = ['servers', 'bridges', 'subscribers', 'partners', 'events', 'docs'];

const Kpi: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="text-right">
    <div className="text-xs font-mono uppercase tracking-wide text-faint">{label}</div>
    <div className="font-mono font-semibold text-lg leading-tight text-ink">{value}</div>
  </div>
);

export const Navbar: React.FC<NavbarProps> = ({
  servers,
  bridges,
  subscribers,
  user,
  readOnly = false,
  live,
  activeTab,
  onSelectTab,
  onAddServer,
  onAddSubscriber,
  onOpenAccount,
  onLogout,
}) => {
  const onlineCount = servers.filter((s) => s.status === 'online').length;
  const activeClients = servers.reduce((acc, s) => acc + (s.active_client_count || 0), 0);
  const bridgesOnline = bridges.filter((b) => b.status === 'online').length;
  const traffic = subscribers.reduce((acc, s) => acc + (s.traffic_used || 0), 0);

  const tabs = TABS.filter(({ id }) => !readOnly || GUEST_TABS.includes(id));
  const current = TABS.find((t) => t.id === activeTab) ?? TABS[0];
  const [menuOpen, setMenuOpen] = useState(false);
  const addAction = !readOnly && activeTab === 'servers'
    ? { label: 'Нода', onClick: onAddServer }
    : !readOnly && activeTab === 'subscribers'
      ? { label: 'Пользователь', onClick: onAddSubscriber }
      : null;
  const liveTitle = live === 'ws' ? 'Статусы приходят по WebSocket мгновенно' : 'Статусы обновляются опросом раз в 15 секунд';

  return (
    <header className="bg-page/85 backdrop-blur-md sticky top-0 z-30 border-b-2 border-brand pt-safe">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-2.5 lg:pb-0 lg:pt-3 flex items-center gap-3 lg:gap-4">
        {/* Телефон и планшет: разделы — в боковом меню */}
        {user && (
          <button
            onClick={() => setMenuOpen(true)}
            aria-label="Меню разделов"
            aria-expanded={menuOpen}
            data-guest-ok
            className="lg:hidden -ml-1 p-2 rounded-lg text-ink hover:bg-soft border border-line"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}

        {/* Логотип и версия; на узком экране под логотипом — текущий раздел */}
        <div className="flex items-center gap-3 min-w-0">
          <BrandMark className="w-8 h-8 hidden lg:block" />
          <div className="min-w-0">
            <div className="brand-plate font-display font-bold text-base leading-none">
              dementia<span className="opacity-60">//</span>
            </div>
            {user && (
              <>
                <div className="hidden lg:block"><PanelVersion canUpdate={!readOnly} /></div>
                <div className="lg:hidden text-xs text-muted truncate mt-0.5">{current.label}</div>
              </>
            )}
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-ok" title={liveTitle}>
          <span className="w-2 h-2 rounded-full bg-ok animate-pulse" />
          {live === 'ws' ? 'LIVE' : 'LIVE · 15 с'}
        </div>

        <div className="flex-1" />

        {/* Сводка */}
        <div className="hidden xl:flex items-center gap-6">
          <Kpi label="Ноды" value={`${onlineCount}/${servers.length}`} />
          <Kpi label="Пиры онлайн" value={activeClients} />
          <Kpi label="Мосты" value={`${bridgesOnline}/${bridges.length}`} />
          <Kpi label="Трафик" value={formatBytes(traffic)} />
        </div>

        {/* Действия и учётная запись; на узком экране остаётся только главное действие раздела */}
        <div className="flex items-center gap-2 shrink-0">
          {addAction && (
            <button
              onClick={addAction.onClick}
              aria-label={`Добавить: ${addAction.label}`}
              className="hud-cut hud-cut-sm flex items-center gap-1.5 bg-brand text-on-accent font-bold text-sm px-3 sm:px-4 py-2 rounded-lg btn-press"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">{addAction.label}</span>
            </button>
          )}

          {user && readOnly && (
            <span title="Гостевой доступ: только просмотр" className="flex items-center gap-1.5 px-3 py-2 text-info bg-info-soft rounded-lg text-xs font-semibold">
              <Eye className="w-4 h-4" />
              <span className="hidden md:inline">Гость</span>
            </span>
          )}

          {user && (
            <div className="hidden lg:flex items-center gap-2">
              <InstallAppButton />
              {!readOnly && (
                <button
                  onClick={onOpenAccount}
                  title={`Учётная запись «${user.username}»: сменить логин или пароль`}
                  className="flex items-center gap-1.5 px-3 py-2 text-ink bg-card border border-line rounded-lg hover:bg-soft transition"
                >
                  <KeyRound className="w-4 h-4" />
                  <span className="max-w-28 truncate text-xs font-mono">{user.username}</span>
                </button>
              )}
              <button
                onClick={onLogout}
                aria-label="Выйти из панели"
                title="Выйти из панели"
                className="p-2 text-ink bg-card border border-line rounded-lg hover:bg-pink hover:text-on-accent transition"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Разделы на широком экране */}
      <nav aria-label="Разделы панели" className="hidden lg:flex max-w-[1600px] mx-auto px-4 sm:px-6 py-2.5 items-center gap-1 overflow-x-auto">
        {tabs.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onSelectTab(id)}
              aria-current={active ? 'page' : undefined}
              className={`shrink-0 flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition whitespace-nowrap ${
                active ? 'bg-soft text-brand shadow-[inset_0_-2px_0_var(--color-brand)]' : 'text-muted hover:text-ink hover:bg-soft'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      {menuOpen && user && (
        <ModalShell label="Меню разделов" variant="drawer" onClose={() => setMenuOpen(false)}>
          <div className="w-[min(20rem,86vw)] h-full bg-card border-r border-line flex flex-col pt-safe animate-in slide-in-from-left duration-200">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
              <BrandMark className="w-8 h-8" />
              <div className="min-w-0 flex-1">
                <div className="brand-plate font-display font-bold text-base leading-none">
                  dementia<span className="opacity-60">//</span>
                </div>
                <PanelVersion canUpdate={!readOnly} />
              </div>
              <button onClick={() => setMenuOpen(false)} aria-label="Закрыть меню" data-guest-ok className="p-2 rounded-lg text-muted hover:text-ink hover:bg-soft border border-line">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
              <div className="grid grid-cols-4 gap-1.5" aria-label="Сводка сети">
                {([
                  ['Ноды', `${onlineCount}/${servers.length}`, 'Ноды в сети'],
                  ['Пиры', activeClients, 'Пиры онлайн'],
                  ['Мосты', `${bridgesOnline}/${bridges.length}`, 'Мосты в работе'],
                  ['Трафик', formatBytes(traffic), 'Трафик пользователей'],
                ] as const).map(([label, value, title]) => (
                  <div key={label} title={title} className="bg-paper border border-line rounded-lg px-2 py-1.5 min-w-0">
                    <div className="text-xs font-mono text-faint truncate">{label}</div>
                    <div className="font-mono font-semibold text-sm text-ink truncate">{value}</div>
                  </div>
                ))}
              </div>

              <nav aria-label="Разделы панели (меню)" className="space-y-1">
                {tabs.map(({ id, label, icon: Icon }) => {
                  const active = activeTab === id;
                  return (
                    <button
                      key={id}
                      data-guest-ok
                      onClick={() => {
                        onSelectTab(id);
                        setMenuOpen(false);
                      }}
                      aria-current={active ? 'page' : undefined}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-left transition ${
                        active ? 'bg-soft text-brand shadow-[inset_3px_0_0_var(--color-brand)]' : 'text-ink hover:bg-soft'
                      }`}
                    >
                      <Icon className={`w-5 h-5 ${active ? 'text-brand' : 'text-muted'}`} />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </nav>

              <div className="flex items-center gap-1.5 px-3 text-xs font-mono text-ok" title={liveTitle}>
                <span className="w-2 h-2 rounded-full bg-ok animate-pulse" />
                {live === 'ws' ? 'LIVE — статусы в реальном времени' : 'LIVE · опрос раз в 15 с'}
              </div>
            </div>

            <div className="border-t border-line px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-2">
              <InstallAppButton wide />
              {!readOnly && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenAccount();
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-ink hover:bg-soft border border-line"
                >
                  <KeyRound className="w-4 h-4 text-muted" />
                  <span className="truncate">Учётная запись <span className="font-mono text-muted">{user.username}</span></span>
                </button>
              )}
              <button
                onClick={onLogout}
                data-guest-ok
                className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-ink hover:bg-pink hover:text-on-accent border border-line transition"
              >
                <LogOut className="w-4 h-4" />
                Выйти
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </header>
  );
};
