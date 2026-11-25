export const API_BASE = '/api';

const TOKEN_KEY = 'dementia_token';
/** Ключ до переименования проекта (Demension, v0.1.3 и раньше) */
const LEGACY_TOKEN_KEY = 'demension_token';

export function getToken(): string | null {
  try {
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacy) {
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      if (!localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, legacy);
    }
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage недоступен (приватный режим) — сессия будет жить до перезагрузки страницы
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options.headers || {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('auth_unauthorized'));
  }

  return res;
}

/**
 * Текст ошибки из ответа; переносит не-JSON ответы (HTML прокси, пустое тело)
 */
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // не JSON
  }
  return `${fallback} (HTTP ${res.status})`;
}

export async function request<T>(url: string, options: RequestInit, fallback: string): Promise<T> {
  const res = await fetchWithAuth(url, options);
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return res.json();
}

export const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
