import React, { useEffect, useState } from 'react';
import { CloudDownload, DatabaseBackup, KeyRound, Loader2, Play, Save, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { BackupSettings, RemoteBackup } from '../types';

const input = 'w-full bg-paper border border-line rounded-xl px-3 py-2 text-sm text-ink';

export const BackupsCard: React.FC = () => {
  const [form, setForm] = useState<BackupSettings | null>(null);
  const [secrets, setSecrets] = useState({ yandex_password: '', google_client_secret: '', google_refresh_token: '' });
  const [files, setFiles] = useState<RemoteBackup[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');

  const loadFiles = async () => {
    try { setFiles((await api.getBackups()).backups); } catch { setFiles([]); }
  };
  useEffect(() => {
    api.getBackupSettings().then((settings) => { setForm(settings); if (settings.yandex_password_saved || settings.google_refresh_token_saved) void loadFiles(); })
      .catch((err) => setMessage({ ok: false, text: err.message }));
  }, []);
  if (!form) return null;

  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try { await fn(); } catch (err: any) { setMessage({ ok: false, text: err.message }); }
    finally { setBusy(false); }
  };
  const save = () => action(async () => {
    const saved = await api.updateBackupSettings({ ...form, ...Object.fromEntries(Object.entries(secrets).filter(([, value]) => value)) });
    setForm(saved); setSecrets({ yandex_password: '', google_client_secret: '', google_refresh_token: '' });
    setMessage({ ok: true, text: 'Настройки резервных копий сохранены' });
  });

  return (
    <section className="bg-card border border-line rounded-2xl p-6 space-y-5">
      <div className="flex items-center gap-2"><DatabaseBackup className="w-5 h-5 text-warn" /><div><h3 className="text-base font-semibold text-ink">Резервные копии</h3><p className="text-xs text-muted">Зашифрованные архивы во внешнем хранилище</p></div></div>
      {message && <div className={`p-3 rounded-xl border border-line text-xs ${message.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}>{message.text}</div>}
      <label className="flex items-center gap-3 text-sm text-ink"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />Автоматически создавать копии</label>
      <div className="grid md:grid-cols-3 gap-3">
        <select aria-label="Хранилище" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as 'yandex' | 'google' })} className={input}><option value="yandex">Яндекс Диск</option><option value="google">Google Drive</option></select>
        <label className="text-xs text-muted">Период, часов<input type="number" min={1} max={168} value={form.interval_hours} onChange={(e) => setForm({ ...form, interval_hours: Number(e.target.value) })} className={`${input} mt-1`} /></label>
        <label className="text-xs text-muted">Хранить копий<input type="number" min={1} max={100} value={form.retention} onChange={(e) => setForm({ ...form, retention: Number(e.target.value) })} className={`${input} mt-1`} /></label>
      </div>
      {form.provider === 'yandex' ? <div className="grid md:grid-cols-2 gap-3">
        <input aria-label="Логин Яндекс Диска" placeholder="Логин Яндекс Диска" value={form.yandex_username} onChange={(e) => setForm({ ...form, yandex_username: e.target.value })} className={input} />
        <input aria-label="Пароль приложения" type="password" placeholder={form.yandex_password_saved ? 'Пароль приложения сохранён' : 'Пароль приложения'} value={secrets.yandex_password} onChange={(e) => setSecrets({ ...secrets, yandex_password: e.target.value })} className={input} />
      </div> : <div className="grid md:grid-cols-2 gap-3">
        <input aria-label="Google Client ID" placeholder="OAuth Client ID" value={form.google_client_id} onChange={(e) => setForm({ ...form, google_client_id: e.target.value })} className={input} />
        <input aria-label="Google Client Secret" type="password" placeholder="OAuth Client Secret" value={secrets.google_client_secret} onChange={(e) => setSecrets({ ...secrets, google_client_secret: e.target.value })} className={input} />
        <input aria-label="Google Refresh Token" type="password" placeholder="OAuth Refresh Token" value={secrets.google_refresh_token} onChange={(e) => setSecrets({ ...secrets, google_refresh_token: e.target.value })} className={input} />
        <input aria-label="Google Folder ID" placeholder="ID папки (необязательно)" value={form.google_folder_id} onChange={(e) => setForm({ ...form, google_folder_id: e.target.value })} className={input} />
      </div>}
      {form.last_error && <div className="text-xs text-bad">Последняя ошибка: {form.last_error}</div>}
      <div className="flex flex-wrap justify-end gap-2">
        <button disabled={busy} onClick={() => action(async () => { const result = await api.testBackups(); setMessage({ ok: result.success, text: result.message }); })} className="px-4 py-2 rounded-full bg-paper text-ink text-sm">Проверить подключение</button>
        <button disabled={busy} onClick={() => action(async () => { const result = await api.runBackup(); if (!result.success) throw new Error(result.error); setMessage({ ok: true, text: 'Копия создана' }); await loadFiles(); })} className="flex items-center gap-2 px-4 py-2 rounded-full bg-paper text-ink text-sm"><Play className="w-4 h-4" />Создать сейчас</button>
        <button disabled={busy} onClick={save} className="flex items-center gap-2 px-4 py-2 rounded-lg btn-press bg-brand text-on-accent text-sm font-bold">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Сохранить</button>
      </div>

      <div className="border-t border-line pt-4 space-y-2">
        <div className="flex items-center justify-between"><h4 className="text-sm font-semibold text-ink">Удалённые копии</h4><button onClick={() => void loadFiles()} className="text-xs text-muted hover:text-ink">Обновить</button></div>
        {files.map((file) => <div key={file.id} className="flex items-center gap-3 bg-paper rounded-xl px-3 py-2 text-xs"><span className="flex-1 truncate text-ink">{file.name}</span><span className="text-muted">{Math.ceil(file.size / 1024)} КБ</span><button title="Скачать" onClick={() => action(() => api.downloadBackup(file.id, file.name))} className="text-info"><CloudDownload className="w-4 h-4" /></button><button title="Удалить" onClick={() => action(async () => { await api.deleteBackup(file.id); await loadFiles(); })} className="text-bad"><Trash2 className="w-4 h-4" /></button></div>)}
        {files.length === 0 && <p className="text-xs text-faint">Список появится после подключения хранилища.</p>}
      </div>

      <div className="border-t border-line pt-4 space-y-3">
        <p className="text-xs text-muted">Ключ восстановления нужен вместе с файлом копии. Сохраните его отдельно: без него расшифровать архив невозможно.</p>
        {recoveryKey ? <textarea readOnly value={recoveryKey} aria-label="Ключ восстановления" className={`${input} h-20 font-mono`} /> : <div className="flex gap-2"><input type="password" placeholder="Пароль администратора" value={password} onChange={(e) => setPassword(e.target.value)} className={input} /><button disabled={!password} onClick={() => action(async () => { setRecoveryKey((await api.getBackupRecoveryKey(password)).recovery_key); setPassword(''); })} className="flex items-center gap-2 px-4 rounded-full bg-paper text-ink text-sm"><KeyRound className="w-4 h-4" />Показать ключ</button></div>}
      </div>
    </section>
  );
};
