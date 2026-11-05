import type { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SshService } from '../src/services/ssh.service.js';

// Подменённый ssh2: клиент сразу «подключается», а канал команды доступен тесту через globalThis
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeStream extends EventEmitter {
    stderr = new EventEmitter();
    end() {}
  }
  class Client extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'));
      return this;
    }
    exec(_command: string, callback: (err: Error | undefined, stream: FakeStream) => void) {
      const stream = new FakeStream();
      (globalThis as any).__fakeSshStream = stream;
      callback(undefined, stream);
    }
    end() {}
  }
  return { Client };
});

const fakeStream = () => (globalThis as any).__fakeSshStream as EventEmitter & { stderr: EventEmitter };
const channelReady = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('#34 ошибки канала SSH', () => {
  it('ошибка канала завершает команду отказом, а не роняет процесс (Unhandled error event)', async () => {
    const pending = SshService.executeCommand({ host: 'node.example.com' }, 'true');
    const assertion = expect(pending).rejects.toThrow('channel reset');
    await channelReady();

    expect(() => fakeStream().emit('error', new Error('channel reset'))).not.toThrow();
    await assertion;
  });

  it('ошибка потока stderr обрабатывается так же', async () => {
    const pending = SshService.executeCommand({ host: 'node.example.com' }, 'true');
    const assertion = expect(pending).rejects.toThrow('stderr broken');
    await channelReady();

    expect(() => fakeStream().stderr.emit('error', new Error('stderr broken'))).not.toThrow();
    await assertion;
  });

  it('ошибка после завершения команды игнорируется', async () => {
    const pending = SshService.executeCommand({ host: 'node.example.com' }, 'true');
    await channelReady();
    const stream = fakeStream();
    stream.emit('data', Buffer.from('ok'));
    stream.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ code: 0, stdout: 'ok' });

    expect(() => stream.emit('error', new Error('late error'))).not.toThrow();
  });
});

describe('вывод команды SSH', () => {
  it('кириллица, разрезанная границей чанка, собирается без «�» (#62)', async () => {
    const chunks: string[] = [];
    const pending = SshService.executeCommand({ host: 'node.example.com' }, 'true', { onData: (c) => chunks.push(c) });
    await channelReady();
    const stream = fakeStream();
    const bytes = Buffer.from('Установка завершена', 'utf8');
    stream.emit('data', bytes.subarray(0, 3)); // «У» — 2 байта, «с» разрезана посередине
    stream.emit('data', bytes.subarray(3));
    const err = Buffer.from('ошибка', 'utf8');
    stream.stderr.emit('data', err.subarray(0, 1));
    stream.stderr.emit('data', err.subarray(1));
    stream.emit('close', 0);
    const result = await pending;
    expect(result.stdout).toBe('Установка завершена');
    expect(result.stderr).toBe('ошибка');
    expect(chunks.join('')).not.toContain('�');
  });

  it('слишком большой вывод прерывает команду, а не копится в памяти панели', async () => {
    const pending = SshService.executeCommand({ host: 'node.example.com' }, 'true', { maxOutputBytes: 1024 });
    const assertion = expect(pending).rejects.toThrow('Вывод команды превысил');
    await channelReady();
    const stream = fakeStream();
    for (let i = 0; i < 4; i++) stream.emit('data', Buffer.alloc(400, 'a'));
    await assertion;
    // Поздние данные и закрытие после отказа игнорируются
    expect(() => {
      stream.stderr.emit('data', Buffer.alloc(400, 'b'));
      stream.emit('close', 0);
    }).not.toThrow();
  });

  it('по умолчанию действует предел MAX_COMMAND_OUTPUT', async () => {
    const { MAX_COMMAND_OUTPUT } = await import('../src/services/ssh.service.js');
    const pending = SshService.executeCommand({ host: 'node.example.com' }, 'true');
    const assertion = expect(pending).rejects.toThrow('Вывод команды превысил');
    await channelReady();
    fakeStream().stderr.emit('data', Buffer.alloc(MAX_COMMAND_OUTPUT + 1));
    await assertion;
  });
});
