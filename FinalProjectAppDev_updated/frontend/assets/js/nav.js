import { api, Session, API_BASE, assetUrl, connectLive } from './api.js';

/* ---------- tiny UI helpers shared by every portal page ---------- */
const ICONS = {
  home: '<path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  user: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6"/>',
  building: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  verify: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  briefcase: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M9 6V4h6v2"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  upload: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  paperclip: '<path d="m21.4 11.1-9.2 9.2a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  award: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13.9 17 22l-5-3-5 3 1.5-8.1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12Z"/>',
  send: '<path d="m22 2-11 11M22 2l-7 20-4-9-9-4Z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  star: '<path d="m12 2 2.9 6.3 6.9.8-5.1 4.6 1.5 6.8L12 17.3 5.9 20.5l1.5-6.8L2.3 9.1l6.9-.8Z"/>',
};
export const icon = (name, size = 17) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

/** Fills every <span data-icon="home" data-size="16"> with its SVG. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 16); });
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const initialsOf = (name) => (name || '?').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
export const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export const fmtDateTime = (d) => d ? new Date(d).toLocaleString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
/** Makes any stored meeting link safe + clickable: adds https:// when missing, rejects anything but http(s). */
export function safeLink(url) {
  const t = String(url || '').trim();
  if (!t) return '';
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try { const u = new URL(full); return /^https?:$/.test(u.protocol) ? u.toString() : ''; } catch { return ''; }
}

const PILL_TONE = { Applied: 'blue', Waitlisted: 'amber', Interviewing: 'violet', Offer: 'green', Accepted: 'green', Declined: 'red', Rejected: 'red', Active: 'green', Draft: 'blue', Closed: 'red',
  Pending: 'amber', Approved: 'green', Submitted: 'blue', Missing: 'gray', Suspended: 'red', Completed: 'green', 'In progress': 'violet' };
export const statusPill = (s) => `<span class="pill pill-${PILL_TONE[s] || 'blue'}">${esc(s)}</span>`;

/* ---------- navigation ---------- */
const STUDENT_LINKS = [
  { href: 'dashboard.html', label: 'Dashboard', key: 'dashboard', icon: 'home' },
  { href: 'profile.html', label: 'Profile', key: 'profile', icon: 'user' },
  { href: 'matches.html', label: 'Matches', key: 'matches', icon: 'target' },
  { href: 'applications.html', label: 'Applications', key: 'applications', icon: 'briefcase' },
  { href: 'ojt.html', label: 'My OJT', key: 'ojt', icon: 'clock' },
  { href: 'messages.html', label: 'Messages', key: 'messages', icon: 'chat' },
  { href: 'settings.html', label: 'Settings', key: 'settings', icon: 'settings' },
];
const COMPANY_LINKS = [
  { href: 'dashboard.html', label: 'Dashboard', key: 'dashboard', icon: 'home' },
  { href: 'profile.html', label: 'Company Profile', key: 'profile', icon: 'building' },
  { href: 'postings.html', label: 'Postings', key: 'postings', icon: 'briefcase' },
  { href: 'applicants.html', label: 'Applicants', key: 'applicants', icon: 'user' },
  { href: 'interns.html', label: 'Interns', key: 'interns', icon: 'users' },
  { href: 'messages.html', label: 'Messages', key: 'messages', icon: 'chat' },
  { href: 'settings.html', label: 'Settings', key: 'settings', icon: 'settings' },
];
const COORDINATOR_LINKS = [
  { href: 'dashboard.html', label: 'Dashboard', key: 'dashboard', icon: 'home' },
  { href: 'students.html', label: 'Students', key: 'students', icon: 'users' },
  { href: 'settings.html', label: 'Settings', key: 'settings', icon: 'settings' },
];
const ADMIN_LINKS = [
  { href: 'dashboard.html', label: 'Overview', key: 'dashboard', icon: 'home' },
  { href: 'accounts.html', label: 'Accounts', key: 'accounts', icon: 'shield' },
];
// Everything that differs between the four portals lives here.
const PORTALS = {
  student:     { links: STUDENT_LINKS,     role: 'Student',     profile: 'profile.html',   search: ['matches.html', 'Search internships or companies…'], me: '/interns/me' },
  company:     { links: COMPANY_LINKS,     role: 'Company',     profile: 'profile.html',   search: ['applicants.html', 'Search applicants…'], me: '/companies/me' },
  coordinator: { links: COORDINATOR_LINKS, role: 'Coordinator', profile: 'settings.html',  search: ['students.html', 'Search students…'], me: null },
  admin:       { links: ADMIN_LINKS,       role: 'Admin',       profile: 'dashboard.html', search: ['accounts.html', 'Search accounts…'], me: null },
};

const avatarInner = (user, initials) => user?.profile_photo_path
  ? `<img src="${assetUrl(user.profile_photo_path)}" alt="" onerror="this.replaceWith(document.createTextNode('${initials}'))">`
  : initials;

export function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;right:20px;bottom:20px;max-width:320px;padding:12px 16px;border-radius:12px;' +
    'background:#2b1f63;color:#fff;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.25);' +
    'z-index:9999;opacity:0;transform:translateY(8px);transition:all .25s;';
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'none'; });
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4500);
}

export function renderNav(portal, activeKey) {
  const user = Session.get();
  const cfg = PORTALS[portal] || PORTALS.student;
  const links = cfg.links;
  const mount = document.getElementById('navMount');
  if (!mount) return;

  const initials = initialsOf(user?.name);
  const roleLabel = cfg.role;

  mount.innerHTML = `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar__brand">
        <div class="sidebar__brand-mark">IT</div>
        <div class="sidebar__brand-name">ITern</div>
      </div>
      <div class="sidebar__label">MENU</div>
      <nav class="sidebar__nav">
        ${links.map(l => `<a class="sidebar__link ${l.key === activeKey ? 'active' : ''}" href="${l.href}">${icon(l.icon)}${l.label}${l.key === 'messages' ? '<span class="nav-badge" id="msgBadge"></span>' : ''}</a>`).join('')}
      </nav>
      <div class="sidebar__spacer"></div>
      <a href="${cfg.profile}" style="text-decoration:none;">
        <div class="sidebar__user" title="Your account">
          <div class="avatar js-avatar">${avatarInner(user, initials)}</div>
          <div>
            <div class="sidebar__user-name">${esc(user?.name || 'Guest')}</div>
            <div class="sidebar__user-role">${roleLabel}</div>
          </div>
        </div>
      </a>
      <button class="btn btn-ghost btn-sm" id="signOutBtn" type="button" style="margin-top:10px;">Sign out</button>
    </aside>`;

  // Topbar (search + notifications + user chip) — only on pages that include #topbarMount
  const topbarMount = document.getElementById('topbarMount');
  if (topbarMount) {
    const [searchTarget, searchHint] = cfg.search;
    topbarMount.innerHTML = `
      <div class="topbar">
        <button class="topbar__menu" id="menuBtn" type="button" aria-label="Open menu">${icon('menu')}</button>
        <div class="topbar__search">
          ${icon('search', 15)}
          <input id="globalSearch" type="search" placeholder="${searchHint}" autocomplete="off">
          <kbd>Ctrl K</kbd>
        </div>
        <div class="topbar__right">
          <div style="position:relative;">
            <button class="topbar__bell" id="notifBtn" type="button" title="Notifications">${icon('bell', 16)}<span class="notif-dot" id="notifDot"></span></button>
            <div class="notif-panel" id="notifPanel"></div>
          </div>
          <div class="topbar__user">
            <div class="avatar js-avatar">${avatarInner(user, initials)}</div>
            <div><div class="topbar__user-name">${esc(user?.name || 'Guest')}</div><div class="topbar__user-role">${roleLabel}</div></div>
          </div>
        </div>
      </div>`;

    const sidebar = document.getElementById('sidebar');
    document.getElementById('menuBtn').addEventListener('click', (e) => { e.stopPropagation(); sidebar.classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!sidebar.contains(e.target)) sidebar.classList.remove('open'); });

    const searchInput = document.getElementById('globalSearch');
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && searchInput.value.trim()) window.location.href = `${searchTarget}?q=${encodeURIComponent(searchInput.value.trim())}`;
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchInput.focus(); }
    });
  }

  document.getElementById('signOutBtn').addEventListener('click', () => {
    Session.clear();
    window.location.href = 'login.html';
  });

  const notifBtn = document.getElementById('notifBtn');
  const notifPanel = document.getElementById('notifPanel');
  const notifDot = document.getElementById('notifDot');

  async function loadNotifications() {
    if (!notifBtn) return;
    try {
      const rows = await api('/notifications', { token: Session.token() });
      const unread = rows.filter(r => !r.is_read).length;
      notifDot.style.display = unread ? 'block' : 'none';
      notifPanel.innerHTML = rows.length
        ? rows.map(r => `<div data-id="${r.id}" style="padding:8px 6px;border-bottom:1px solid var(--ink-50);
            font-size:12px;font-weight:${r.is_read ? '400' : '700'};cursor:pointer;">${esc(r.message)}</div>`).join('')
        : '<div style="padding:8px;color:var(--ink-500);font-size:12px;">No notifications yet.</div>';
      notifPanel.querySelectorAll('[data-id]').forEach(el => el.addEventListener('click', async () => {
        await api(`/notifications/${el.dataset.id}/read`, { method: 'PATCH', token: Session.token() });
        loadNotifications();
      }));
    } catch { /* notifications route only exists from Day 6 onward */ }
  }

  if (notifBtn) {
    notifBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      notifPanel.style.display = notifPanel.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', (e) => { if (!notifPanel.contains(e.target)) notifPanel.style.display = 'none'; });
    loadNotifications();
    setInterval(loadNotifications, 120000); // fallback only — live stream does the real work
  }

  // The user object cached in Session is only a snapshot from login time —
  // it never reflects a profile picture uploaded/changed/removed afterward.
  // Fetch the current record on every page load so the avatar stays in sync.
  async function loadAvatar() {
    const avatars = document.querySelectorAll('.js-avatar');
    if (!avatars.length) return;
    try {
      if (!cfg.me) { avatars.forEach(el => { if (!el.querySelector('img')) el.textContent = initials; }); return; } // coordinators/admins have no photo
      const me = await api(cfg.me, { token: Session.token() });
      avatars.forEach(el => {
        el.innerHTML = me.profile_photo_path
          ? `<img src="${assetUrl(me.profile_photo_path)}" alt="${esc(me.name || '')}">`
          : initials;
      });
      // Remember it so the next page shows the picture immediately instead of flashing initials.
      const cached = Session.get();
      if (cached && cached.profile_photo_path !== (me.profile_photo_path || null)) {
        Session.set({ ...cached, profile_photo_path: me.profile_photo_path || null }, Session.token());
      }
    } catch {
      // /me can fail before the DB migration for profile_photo_path has
      // been run, or if the token is stale — fall back to initials.
      avatars.forEach(el => { el.textContent = initials; });
    }
  }

  /* ---------- real-time: server pushes events, no refresh needed ---------- */
  if (Session.token() && !window.__iternLive) {
    window.__iternLive = connectLive((name, data) => {
      if (name === 'notification') { toast(data.message); loadNotifications(); }
      if (name === 'resync') { loadNotifications(); loadUnread(); }
      if (name === 'message:new') {
        // No pop-up if you're already looking at that very conversation.
        const watching = window.__iternActiveChat === data.conversationId && !document.hidden;
        if (!watching) toast(`${data.senderName}: ${data.preview}`);
        loadUnread();
      }
      if (name === 'message:read') loadUnread();
      if (name === 'account:status') { toast('Your account status was updated.'); setTimeout(() => location.reload(), 1500); }
      // Pages listen for this and re-run their own load function.
      window.dispatchEvent(new CustomEvent('itern:live', { detail: { name, data } }));
    });
  }

  // Unread-messages badge on the sidebar "Messages" link.
  async function loadUnread() {
    const badge = document.getElementById('msgBadge');
    if (!badge) return;
    try {
      const { count } = await api('/messages/unread-count', { token: Session.token() });
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = count ? 'inline-grid' : 'none';
    } catch { badge.style.display = 'none'; }
  }
  window.addEventListener('itern:unread-changed', loadUnread);

  // New companies / coordinators wait for an admin: say so clearly instead of letting things silently not work.
  async function showApprovalBanner() {
    if (portal !== 'company' && portal !== 'coordinator') return;
    try {
      const acc = await api('/account', { token: Session.token() });
      if (acc.account_status !== 'Pending') return;
      const main = document.querySelector('main.main') || document.querySelector('main');
      if (!main || document.getElementById('approvalBanner')) return;
      main.insertAdjacentHTML('afterbegin', `<div class="notice-banner" id="approvalBanner"><b>Waiting for admin approval.</b>
        ${portal === 'company'
          ? 'You can set up your profile and save draft postings now. Your postings become visible to students once the ITern admin approves your company.'
          : 'You can set up your account now. Student placements, hours and documents appear once the ITern admin approves you.'}</div>`);
    } catch { /* not critical */ }
  }

  hydrateIcons();
  loadAvatar();
  loadUnread();
  showApprovalBanner();
  return { refreshAvatar: loadAvatar };
}

// Any request that fails and nobody handles -> tell the user instead of leaving a blank page.
let lastErrAt = 0;
window.addEventListener('unhandledrejection', (e) => {
  if (Date.now() - lastErrAt < 4000) return;
  lastErrAt = Date.now();
  const t = document.createElement('div');
  t.textContent = (e.reason && e.reason.message) || 'Something went wrong.';
  t.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);padding:10px 16px;border-radius:10px;' +
    'background:#b42318;color:#fff;font-size:13px;font-weight:600;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.25);';
  document.body.appendChild(t); setTimeout(() => t.remove(), 5000);
});

/** Renders an inline SVG match ring. */
export function matchRing(score, { size = 52 } = {}) {
  const r = 21, c = 2 * Math.PI * r;
  const offset = c - (Math.min(Math.max(score, 0), 100) / 100) * c;
  return `
    <div class="match-ring" style="--size:${size}px">
      <svg viewBox="0 0 52 52">
        <defs>
          <linearGradient id="ringGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#7C5CFF"/>
            <stop offset="100%" stop-color="#12C79E"/>
          </linearGradient>
        </defs>
        <circle class="track" cx="26" cy="26" r="${r}" />
        <circle class="fill" cx="26" cy="26" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${offset}" />
      </svg>
      <div class="pct">${score}%</div>
    </div>`;
}

/** Runs `fn` whenever the server pushes a change (debounced). Use it to re-load a page's data. */
export function onLive(fn, names = ['applications:changed', 'postings:changed', 'resync']) {
  let timer;
  window.addEventListener('itern:live', (e) => {
    if (!names.includes(e.detail.name)) return;
    clearTimeout(timer);
    timer = setTimeout(fn, 300);
  });
}