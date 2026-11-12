import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/error-handler.js';
import { jsonBody } from '../src/middleware/json-body.js';

describe('jsonBody', () => {
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(jsonBody);
    app.post('/body', (req, res) => {
      const { value } = req.body;
      if (!value) return res.status(400).json({ error: 'Значение обязательно' });
      res.json({ value });
    });
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/body`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ['без тела', {}],
    ['с текстовым телом', { headers: { 'Content-Type': 'text/plain' }, body: 'text' }],
  ])('%s передаёт пустой объект в обработчик', async (_name, options) => {
    const res = await fetch(url, { method: 'POST', ...options });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Значение обязательно' });
  });

  it('сохраняет разобранный JSON', async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":"ok"}' });
    expect(await res.json()).toEqual({ value: 'ok' });
  });
});
