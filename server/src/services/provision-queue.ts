// Все операции с одной нодой выполняются последовательно (с мостом — по ключу `bridge:<id>`)
const chains = new Map<number | string, Promise<unknown>>();

export function runExclusive<T>(serverId: number | string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(serverId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  chains.set(serverId, tail);
  tail.then(() => {
    if (chains.get(serverId) === tail) chains.delete(serverId);
  });
  return next;
}

/**
 * Ожидает завершения активных операций в очереди нод и мостов (с ограничением по времени для graceful shutdown).
 */
export async function waitForActiveOperations(timeoutMs = 15000): Promise<void> {
  if (chains.size === 0) return;
  const active = Promise.allSettled(chains.values());
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      active,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
