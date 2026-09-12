export const API_BASE = 'http://localhost:4000/api';

export async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const Session = {
  set(user, token) { localStorage.setItem('itern_user', JSON.stringify(user)); localStorage.setItem('itern_token', token); },
  get() { try { return JSON.parse(localStorage.getItem('itern_user')); } catch { return null; } },
  token() { return localStorage.getItem('itern_token'); },
  clear() { localStorage.removeItem('itern_user'); localStorage.removeItem('itern_token'); },
};
