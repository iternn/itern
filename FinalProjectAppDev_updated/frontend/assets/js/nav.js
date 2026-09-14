import { api, Session, API_BASE } from './api.js';

const STUDENT_LINKS = [
  { href: 'dashboard.html', label: 'Dashboard', key: 'dashboard' },
  { href: 'profile.html', label: 'Profile', key: 'profile' },
  { href: 'skills-test.html', label: 'Verify Skills', key: 'skills-test' },
  { href: 'matches.html', label: 'Matches', key: 'matches' },
  { href: 'applications.html', label: 'Applications', key: 'applications' },
];
const COMPANY_LINKS = [
  { href: 'dashboard.html', label: 'Dashboard', key: 'dashboard' },
  { href: 'profile.html', label: 'Company Profile', key: 'profile' },
  { href: 'postings.html', label: 'Postings', key: 'postings' },
  { href: 'applicants.html', label: 'Applicants', key: 'applicants' },
];

export function renderNav(portal, activeKey) {
  const user = Session.get();
  const links = portal === 'company' ? COMPANY_LINKS : STUDENT_LINKS;
  const mount = document.getElementById('navMount');
  if (!mount) return;

  const initials = (user?.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

  mount.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar__brand">
        <div class="sidebar__brand-mark">IT</div>
        <div class="sidebar__brand-name">ITern</div>
        <div style="margin-left:auto;position:relative;">
          <button class="sidebar__icon-btn" id="notifBtn" type="button" title="Notifications" style="margin-left:0;">
            &#128276;<span class="notif-dot" id="notifDot"></span>
          </button>
          <div class="notif-panel" id="notifPanel" style="left:auto;right:0;bottom:auto;top:36px;"></div>
        </div>
      </div>
      <div class="sidebar__label">MENU</div>
      <nav class="sidebar__nav">
        ${links.map(l => `<a class="sidebar__link ${l.key === activeKey ? 'active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
      </nav>
      <div class="sidebar__spacer"></div>
      <a href="profile.html" style="text-decoration:none;">
        <div class="sidebar__user" title="Edit your profile">
          <div class="avatar" id="sidebarAvatar">${initials}</div>
          <div>
            <div class="sidebar__user-name">${user?.name || 'Guest'}</div>
            <div class="sidebar__user-role">${portal === 'company' ? 'Company' : 'Student'}</div>
          </div>
        </div>
      </a>
      <button class="btn btn-ghost btn-sm" id="signOutBtn" type="button" style="margin-top:10px;">Sign out</button>
    </aside>`;

  document.getElementById('signOutBtn').addEventListener('click', () => {
    Session.clear();
    window.location.href = 'login.html';
  });

  async function loadNotifications() {
    try {
      const rows = await api('/notifications', { token: Session.token() });
      const unread = rows.filter(r => !r.is_read).length;
      notifDot.style.display = unread ? 'block' : 'none';
      notifPanel.innerHTML = rows.length
        ? rows.map(r => `<div data-id="${r.id}" style="padding:8px 6px;border-bottom:1px solid var(--ink-50);
            font-size:12px;font-weight:${r.is_read ? '400' : '700'};cursor:pointer;">${r.message}</div>`).join('')
        : '<div style="padding:8px;color:var(--ink-500);font-size:12px;">No notifications yet.</div>';
      notifPanel.querySelectorAll('[data-id]').forEach(el => el.addEventListener('click', async () => {
        await api(`/notifications/${el.dataset.id}/read`, { method: 'PATCH', token: Session.token() });
        loadNotifications();
      }));
    } catch { /* notifications route only exists from Day 6 onward */ }
  }

  notifBtn.addEventListener('click', () => {
    notifPanel.style.display = notifPanel.style.display === 'block' ? 'none' : 'block';
  });

  loadNotifications();
  setInterval(loadNotifications, 30000);

  // The user object cached in Session is only a snapshot from login time —
  // it never reflects a profile picture uploaded/changed/removed afterward.
  // Fetch the current record on every page load so the sidebar stays in
  // sync with whatever was last saved on the Profile page.
  async function loadAvatar() {
    const avatarEl = document.getElementById('sidebarAvatar');
    if (!avatarEl) return;
    try {
      const endpoint = portal === 'company' ? '/companies/me' : '/interns/me';
      const me = await api(endpoint, { token: Session.token() });
      if (me.profile_photo_path) {
        avatarEl.innerHTML = `<img src="${API_BASE.replace('/api', '')}/${me.profile_photo_path}" alt="${me.name || ''}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
      } else {
        avatarEl.textContent = initials;
      }
    } catch {
      // /me can fail before the DB migration for profile_photo_path has
      // been run, or if the token is stale — fall back to initials rather
      // than leaving the sidebar broken.
      avatarEl.textContent = initials;
    }
  }

  loadAvatar();
  return { refreshAvatar: loadAvatar };
}

/** Renders an inline SVG match ring — call after inserting HTML that contains
    the placeholder markup from matchRing(). */
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
