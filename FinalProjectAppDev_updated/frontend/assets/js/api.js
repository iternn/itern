export const API_BASE = 'http://localhost:4000/api';
export const ORIGIN = API_BASE.replace(/\/api$/, '');
/** URL for an uploaded file (profile photo etc.) stored as a relative path like uploads/photos/x.png */
export const assetUrl = (p) => p ? `${ORIGIN}/${encodeURI(String(p).replace(/\\/g, '/'))}` : '';

export async function api(path, { method = 'GET', body, token } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000); // never hang forever -> page can show an error
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? 'The server took too long to respond. Please try again.'
      : 'Cannot reach the server. Is the backend running?');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && /token/i.test(data.error || '')) {
    // Stale/expired login (e.g. another account logged in in this browser): go back to login.
    Session.clear();
    location.href = 'login.html'; // same folder as every portal page
  }
  if (res.status === 403 && data.code === 'ACCOUNT_BLOCKED' && token) {
    // An admin suspended / rejected this account: end the session.
    Session.clear();
    location.href = 'login.html';
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const Session = {
  set(user, token) { localStorage.setItem('itern_user', JSON.stringify(user)); localStorage.setItem('itern_token', token); },
  get() { try { return JSON.parse(localStorage.getItem('itern_user')); } catch { return null; } },
  token() { return localStorage.getItem('itern_token'); },
  clear() { localStorage.removeItem('itern_user'); localStorage.removeItem('itern_token'); },
};

/**
 * Real-time stream (Server-Sent Events). Browsers allow only ~6 open connections per server,
 * so only the tab you're LOOKING at keeps one open; background tabs release theirs and
 * catch up (a 'resync' event) when you come back.
 */
export function connectLive(onEvent) {
  if (!Session.token()) return null;
  let es = null;
  const open = () => {
    if (es || document.hidden) return;
    es = new EventSource(`${API_BASE}/events?token=${encodeURIComponent(Session.token())}`);
    ['notification', 'applications:changed', 'postings:changed', 'message:new', 'message:read', 'message:typing', 'ojt:changed', 'account:status'].forEach((name) =>
      es.addEventListener(name, (e) => onEvent(name, JSON.parse(e.data || '{}'))));
    es.onerror = () => { if (es && es.readyState === EventSource.CLOSED) es = null; };
  };
  const close = () => { if (es) { es.close(); es = null; } };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) close();
    else { open(); onEvent('resync', {}); }
  });
  window.addEventListener('pagehide', close);
  open();
  return { close };
}