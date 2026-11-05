import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Client, ConnectConfig } from 'ssh2';

export interface SshCredentials {
  host: string;
  port?: number;
  username?: string;
  password?: string | null;
  privateKey?: string | null;
  /** Сохранённый отпечаток ключа хоста (SHA256:...). Если не задан — доверяем при первом подключении (TOFU). */
  hostKey?: string | null;
  /** Вызывается с отпечатком ключа хоста при первом успешном подключении */
  onNewHostKey?: (fingerprint: string) => void;
}

export interface CommandOptions {
  /** Данные, передаваемые в stdin удалённой команды */
  input?: string;
  onData?: (chunk: string) => void;
  timeoutMs?: number;
  /** Предел накопленного stdout+stderr в байтах (по умолчанию MAX_COMMAND_OUTPUT): нода — недоверенная сторона */
  maxOutputBytes?: number;
}

/** Вывод команд панели — конфиги, дампы, журналы установки — намного меньше; больше — признак сбоя или атаки с ноды */
export const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;

export class HostKeyMismatchError extends Error {
  constructor(public expected: string, public actual: string) {
    super(
      `Ключ SSH-хоста изменился (ожидался ${expected}, получен ${actual}). ` +
        'Возможна атака «человек посередине». Если сервер был переустановлен, сбросьте сохранённый ключ в настройках сервера.'
    );
  }
}

export function fingerprintHostKey(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

export class SshService {
  /**
   * Префикс для команд, требующих root: для не-root пользователя используется sudo без запроса пароля.
   */
  static sudo(credentials: SshCredentials): string {
    return (credentials.username || 'root') === 'root' ? '' : 'sudo -n ';
  }

  private static connect(credentials: SshCredentials, readyTimeout: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let mismatch: HostKeyMismatchError | null = null;
      let seenFingerprint: string | null = null;

      const config: ConnectConfig = {
        host: credentials.host,
        port: credentials.port || 22,
        username: credentials.username || 'root',
        readyTimeout,
        keepaliveInterval: 15000,
        hostVerifier: (key: Buffer) => {
          seenFingerprint = fingerprintHostKey(key);
          if (credentials.hostKey && credentials.hostKey !== seenFingerprint) {
            mismatch = new HostKeyMismatchError(credentials.hostKey, seenFingerprint);
            return false;
          }
          return true;
        },
      };

      if (credentials.privateKey && credentials.privateKey.trim().length > 0) {
        config.privateKey = credentials.privateKey;
      } else if (credentials.password) {
        config.password = credentials.password;
      }

      conn
        .on('ready', () => {
          if (!credentials.hostKey && seenFingerprint && credentials.onNewHostKey) {
            credentials.onNewHostKey(seenFingerprint);
          }
          resolve(conn);
        })
        .on('error', (err) => reject(mismatch || err))
        .connect(config);
    });
  }

  /**
   * Test SSH connection
   */
  static async testConnection(credentials: SshCredentials): Promise<{ success: boolean; message?: string }> {
    try {
      const conn = await this.connect(credentials, 10000);
      conn.end();
      return { success: true, message: 'Подключение успешно установлено!' };
    } catch (err: any) {
      return { success: false, message: `Ошибка подключения: ${err.message}` };
    }
  }

  /**
   * Execute command on remote host with streaming stdout/stderr
   */
  static async executeCommand(
    credentials: SshCredentials,
    command: string,
    options: CommandOptions | ((chunk: string) => void) = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const opts: CommandOptions = typeof options === 'function' ? { onData: options } : options;
    const conn = await this.connect(credentials, 15000);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            conn.end();
            reject(new Error(`Превышено время выполнения команды (${Math.round(opts.timeoutMs! / 1000)} с)`));
          }, opts.timeoutMs)
        : null;

      conn.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });

      conn.exec(command, (err, stream) => {
        if (err) {
          settled = true;
          if (timer) clearTimeout(timer);
          conn.end();
          return reject(err);
        }

        // Ошибка канала без слушателя завершила бы весь процесс панели (Unhandled 'error' event)
        const failChannel = (channelErr: Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          conn.end();
          reject(channelErr);
        };
        stream.on('error', failChannel);
        stream.stderr.on('error', failChannel);

        // Декодер на поток: многобайтовый символ (кириллица), разрезанный границей чанка, не превращается в «�»
        const outDecoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        const limit = opts.maxOutputBytes ?? MAX_COMMAND_OUTPUT;
        let received = 0;
        const accept = (data: Buffer): boolean => {
          if (settled) return false;
          received += data.length;
          if (received <= limit) return true;
          failChannel(new Error(`Вывод команды превысил ${Math.round(limit / 1024 / 1024)} МБ — команда прервана`));
          return false;
        };

        stream
          .on('close', (code: number | null) => {
            if (timer) clearTimeout(timer);
            conn.end();
            if (settled) return;
            settled = true;
            const outTail = outDecoder.end();
            const errTail = errDecoder.end();
            stdout += outTail;
            stderr += errTail;
            if (opts.onData && outTail + errTail) opts.onData(outTail + errTail);
            resolve({ code: code ?? -1, stdout, stderr });
          })
          .on('data', (data: Buffer) => {
            if (!accept(data)) return;
            const text = outDecoder.write(data);
            stdout += text;
            if (opts.onData && text) opts.onData(text);
          })
          .stderr.on('data', (data: Buffer) => {
            if (!accept(data)) return;
            const text = errDecoder.write(data);
            stderr += text;
            if (opts.onData && text) opts.onData(text);
          });

        if (opts.input !== undefined) {
          stream.end(opts.input);
        } else {
          stream.end();
        }
      });
    });
  }
}
