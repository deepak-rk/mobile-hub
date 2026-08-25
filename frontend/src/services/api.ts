import axios from 'axios';

// The `/api` prefix is always appended, never replaced: with no
// VITE_API_URL we get `/api` (dev proxy + nginx both route that to the
// backend), and with one set we get e.g. `http://host:3000/api`. Setting
// baseURL to VITE_API_URL alone would silently drop the prefix and 404
// every request in the docker-compose build, which passes it as a build arg.
const API_ORIGIN = import.meta.env.VITE_API_URL ?? '';

/** Single source of truth for where the JWT lives (auth writes it, this client reads it). */
export const TOKEN_STORAGE_KEY = 'mh_token';

export const api = axios.create({
  baseURL: `${API_ORIGIN}/api`,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT from localStorage on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Normalise errors into { code, message }
api.interceptors.response.use(
  (res) => res,
  (err: unknown) => {
    if (axios.isAxiosError(err) && err.response?.data) {
      return Promise.reject(err.response.data as { code: string; message: string });
    }
    return Promise.reject({ code: 'NETWORK_ERROR', message: 'Network error' });
  },
);
