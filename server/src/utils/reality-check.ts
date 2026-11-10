import net from 'node:net';
import tls from 'node:tls';
import { Duplex, Transform } from 'node:stream';
import { isValidHost, isValidPort } from './net.js';

const MAX_HANDSHAKE_BYTES = 128 * 1024;
const HANDSHAKE_TIMEOUT_MS = 8000;

/** Путь до сайта маскировки, включая доверенную цепочку и имя, без авторизации VLESS. */
export function checkRealityCertificate(
  host: string,
  port: number,
  servername: string,
  options: { ca?: tls.SecureContextOptions['ca']; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!isValidHost(host) || !isValidPort(port) || !isValidHost(servername) || net.isIP(servername)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let received = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_HANDSHAKE_BYTES) callback(new Error('Превышен размер ответа TLS'));
        else callback(null, chunk);
      },
    });
    const transport = Duplex.from({ readable: bounded, writable: socket });
    let secure: tls.TLSSocket | undefined;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      secure?.destroy();
      transport.destroy();
      bounded.destroy();
      socket.destroy();
      resolve(ok);
    };
    const deadline = setTimeout(() => finish(false), options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    const fail = () => finish(false);
    socket.on('error', fail);
    bounded.on('error', fail);
    transport.on('error', fail);
    socket.pipe(bounded);
    try {
      secure = tls.connect({
        socket: transport, servername, rejectUnauthorized: true, minVersion: 'TLSv1.3',
        ALPNProtocols: ['h2', 'http/1.1'], ca: options.ca,
      });
      secure.on('error', fail);
      secure.once('close', fail);
      secure.once('secureConnect', () => finish(secure?.authorized === true));
    } catch {
      finish(false);
    }
  });
}
