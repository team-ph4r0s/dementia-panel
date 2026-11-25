import { adminApi } from './admin';
import { bridgesApi } from './bridges';
import { serversApi } from './servers';
import { subscribersApi } from './subscribers';

export { clearToken, getToken, setToken } from './client';

export const api = {
  ...serversApi,
  ...subscribersApi,
  ...bridgesApi,
  ...adminApi,
};
