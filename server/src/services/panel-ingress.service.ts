import net from 'node:net';
import { HttpError } from '../utils/http.js';

/** Additional panel entrance. The primary listener and all UDP containers remain untouched. */
export class PanelIngressService {
  private static factory: (() => net.Server) | null = null;
  private static listeners = new Map<number, net.Server>();
  static configure(factory: () => net.Server): void { this.factory = factory; }
  static isOpen(port: number): boolean { return this.listeners.has(port) || port === (Number(process.env.PORT) || 3001); }

  static async open(port: number): Promise<void> {
    if (this.isOpen(port)) return;
    if (!this.factory) throw new HttpError(503, 'Вход панели ещё не готов');
    const server = this.factory();
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new HttpError(409, `Не удалось открыть TCP-порт ${port}. Он занят или недостаточно прав; выберите другой HTTPS-порт Cloudflare.`));
      server.once('error', fail);
      server.listen(port, () => {
        server.removeListener('error', fail);
        server.on('error', () => console.error('[CLOUDFLARE] Ошибка дополнительного входа панели'));
        resolve();
      });
    });
    this.listeners.set(port, server);
  }

  static close(port: number): void {
    this.listeners.get(port)?.close();
    this.listeners.delete(port);
  }
}
