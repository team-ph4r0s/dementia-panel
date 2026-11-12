import express, { type RequestHandler } from 'express';

// Express 5 оставляет req.body undefined, если тело не разобрано.
export const jsonBody: RequestHandler[] = [
  express.json({ limit: '1mb' }),
  (req, _res, next) => {
    req.body ??= {};
    next();
  },
];
