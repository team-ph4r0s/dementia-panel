interface Bucket {
  failures: number;
  resetAt: number;
}

/**
 * Простой счётчик неудачных попыток в памяти (на ключ — IP или логин).
 */
export class FailureLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private maxFailures: number, private windowMs: number, private maxKeys = 50_000) {}

  get size(): number {
    return this.buckets.size;
  }

  /** Сколько миллисекунд осталось до разблокировки (0 — не заблокирован) */
  blockedFor(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const now = Date.now();
    if (bucket.resetAt <= now) {
      this.buckets.delete(key);
      return 0;
    }
    return bucket.failures >= this.maxFailures ? bucket.resetAt - now : 0;
  }

  registerFailure(key: string): void {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      // Память не растёт без предела при переборе с множества адресов/логинов: сначала истёкшие, затем самые старые записи
      if (!bucket && this.buckets.size >= this.maxKeys) {
        this.cleanup();
        for (const oldest of this.buckets.keys()) {
          if (this.buckets.size < this.maxKeys) break;
          this.buckets.delete(oldest);
        }
      }
      this.buckets.delete(key);
      this.buckets.set(key, { failures: 1, resetAt: now + this.windowMs });
    } else {
      bucket.failures++;
    }
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

// 5 неудачных попыток за 15 минут с одного IP, 10 — на один логин
export const loginIpLimiter = new FailureLimiter(5, 15 * 60 * 1000);
export const loginUserLimiter = new FailureLimiter(10, 15 * 60 * 1000);
// Неверный пароль при подтверждении действий уже вошедшим администратором (смена пароля/логина, перенос панели):
// 5 попыток за 15 минут на администратора — украденная сессия не должна позволять подбирать пароль
export const reauthLimiter = new FailureLimiter(5, 15 * 60 * 1000);
// Неверный код переноса панели: 10 попыток за 15 минут с одного IP
export const migrationCodeLimiter = new FailureLimiter(10, 15 * 60 * 1000);
