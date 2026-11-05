import React, { useState, useEffect } from 'react';
import type { SslStatus, Fail2banStatus, PanelSettings } from '../types';
import { api } from '../api';
import { PanelSettingsCard } from './PanelSettingsCard';
import { MigrationCard } from './MigrationCard';
import { TelegramCard } from './TelegramCard';
import { BackupsCard } from './BackupsCard';
import { GuestAccessCard } from './GuestAccessCard';
import { HttpsCard } from './security/HttpsCard';
import { Fail2banCard } from './security/Fail2banCard';
import { CloudflarePanelCard } from './security/CloudflarePanelCard';

export const SecurityView: React.FC<{
  publicUrl: string | null;
  onSettingsSaved?: (settings: PanelSettings) => void;
  onMigrationChange?: () => void;
}> = ({ publicUrl, onSettingsSaved, onMigrationChange }) => {
  const [sslStatus, setSslStatus] = useState<SslStatus | null>(null);
  const [f2bStatus, setF2bStatus] = useState<Fail2banStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSecurityData = async () => {
    try {
      const [ssl, f2b] = await Promise.all([api.getSslStatus(), api.getFail2banStatus()]);
      setSslStatus(ssl);
      setF2bStatus(f2b);
    } catch (err: any) {
      console.error('Ошибка загрузки статуса безопасности:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void Promise.resolve().then(loadSecurityData);
  }, []);

  if (loading) {
    return <div className="text-center py-24 text-faint text-sm">Загрузка настроек безопасности...</div>;
  }

  return (
    <div className="space-y-8">
      <PanelSettingsCard onSaved={onSettingsSaved} />
      <GuestAccessCard />
      <TelegramCard />
      <BackupsCard />
      <HttpsCard sslStatus={sslStatus} onStatusChange={setSslStatus} onReload={loadSecurityData} />
      <CloudflarePanelCard onChanged={() => {
        void loadSecurityData();
        void api.getSettings().then((settings) => onSettingsSaved?.(settings)).catch(() => {
          // Enabling HTTPS can make this tab's old HTTP address unavailable; the new domain link stays visible.
        });
        onMigrationChange?.();
      }} />
      <Fail2banCard f2bStatus={f2bStatus} onReload={loadSecurityData} />

      {/* Перенос панели на другой сервер */}
      <MigrationCard publicUrl={publicUrl} onStateChange={onMigrationChange} />
    </div>
  );
};
