import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Обёртка для async-обработчиков: отклонённый промис передаётся в error middleware.
 */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => unknown
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}

/**
 * Имя файла для Content-Disposition: ASCII-фолбэк + RFC 5987 для UTF-8.
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const safe = filename.replace(/[\r\n"\\/]/g, '_').slice(0, 120) || 'file';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Значение заголовка, допускающее любые символы (HAPP/Streisand понимают префикс base64:).
 */
export function base64HeaderValue(value: string): string {
  return `base64:${Buffer.from(value, 'utf-8').toString('base64')}`;
}

export function parseId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Некорректный идентификатор');
  }
  return id;
}
