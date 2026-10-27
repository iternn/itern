// Account settings for both portals: name, email (re-verified by a code), password, delete account.
import { api, Session } from './api.js';
import { esc, initialsOf, toast } from './nav.js';
import { confirmDialog } from './dialog.js';

export function mountSettings({ portal, root }) {
  const token = () => Session.token();
  const isCompany = portal === 'company';
  const isStudent = portal === 'student';
  const isCoordinator = portal === 'coordinator';
  let account = null;

  const showMsg = (el, text, ok = false) => { el.textContent = text; el.classList.add('show'); el.classList.toggle('ok-text', ok); el.classList.toggle('error-text', !ok); };
  const clearMsg = (el) => el.classList.remove('show');

  // Keeps the sidebar / top bar in step after a name change, without a page reload.
  function refreshChrome(user) {
    document.querySelectorAll('.sidebar__user-name, .topbar__user-name').forEach((el) => { el.textContent = user.name; });
    document.querySelectorAll('.js-avatar').forEach((el) => { if (!el.querySelector('img')) el.textContent = initialsOf(user.name); });
  }
  const saveSession = (user, newToken) => Session.set({ ...Session.get(), ...user }, newToken || token());

  async function load() {
    account = await api('/account', { token: token() });
    render();
  }

  function render() {
    root.innerHTML = `<div class="settings-stack">
      <section class="card">
        <h3>${isCompany ? 'Company name' : 'Your name'}</h3>
        <p class="help-text">${isCompany ? 'Shown to students on your postings and profile.' : 'Shown to companies on your applications.'}</p>
        <form id="nameForm"><div class="field"><input class="input" id="nameInput" value="${esc(account.name)}" maxlength="120" required></div>
          <button class="btn btn-primary" type="submit">Save name</button>
          <div class="error-text" id="nameMsg"></div></form>
      </section>

      ${isStudent || isCoordinator ? `<section class="card">
        <h3>${isStudent ? 'School & program' : 'School & role'}</h3>
        <p class="help-text">${isStudent
          ? 'Your school links you to your school\'s OJT coordinator, who can then follow your placement. Use your school\'s full name.'
          : 'Students are linked to you by this school name.'}</p>
        <form id="detailsForm">
          <div class="row2">
            <div class="field"><label>School</label><input class="input" id="schoolInput" list="schoolList" value="${esc(account.school || '')}" required maxlength="160"><datalist id="schoolList"></datalist></div>
            <div class="field"><label>${isStudent ? 'Program / year' : 'Your role'}</label><input class="input" id="extraInput" value="${esc((isStudent ? account.program : account.position) || '')}" maxlength="160"></div>
          </div>
          <button class="btn btn-primary" type="submit">Save</button>
          <div class="error-text" id="detailsMsg"></div>
        </form>
      </section>` : ''}

      <section class="card">
        <h3>Email address</h3>
        <p class="help-text">You log in with <b>${esc(account.email)}</b>. To change it we'll send a code to the new address.</p>
        <form id="emailForm">
          <div class="field"><input class="input" id="newEmail" type="email" placeholder="New email address" required></div>
          <button class="btn btn-ghost" type="submit" id="sendCodeBtn">Send verification code</button>
        </form>
        <form id="emailConfirm" style="display:none;margin-top:16px;">
          <div class="field"><label>6-digit code sent to <span id="sentTo"></span></label><input class="input" id="emailCode" inputmode="numeric" maxlength="6" required></div>
          <div class="field"><label>Your password</label><input class="input" id="emailPw" type="password" required autocomplete="current-password"></div>
          <button class="btn btn-primary" type="submit">Confirm new email</button>
        </form>
        <div class="error-text" id="emailMsg"></div>
      </section>

      <section class="card">
        <h3>Password</h3>
        <p class="help-text">Use at least 8 characters.</p>
        <form id="pwForm">
          <div class="field"><label>Current password</label><input class="input" id="curPw" type="password" required autocomplete="current-password"></div>
          <div class="row2">
            <div class="field"><label>New password</label><input class="input" id="newPw" type="password" required minlength="8" autocomplete="new-password"></div>
            <div class="field"><label>Confirm new password</label><input class="input" id="newPw2" type="password" required minlength="8" autocomplete="new-password"></div>
          </div>
          <button class="btn btn-primary" type="submit">Change password</button>
          <div class="error-text" id="pwMsg"></div>
        </form>
      </section>

      <section class="card">
        <h3>Email notifications</h3>
        <p class="help-text">Get an email when you have an unread message, and when an interview is scheduled or coming up. Notifications inside ITern always stay on.</p>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-weight:600;font-size:14px;">
          <input type="checkbox" id="emailPref" ${account.email_notifications === 0 ? '' : 'checked'} style="width:18px;height:18px;accent-color:var(--violet-500);"> Email me about new messages and interviews</label>
        <div class="ok-text" id="prefMsg"></div>
      </section>

      <section class="card danger-zone">
        <h3 style="color:var(--rose-500);">Delete account</h3>
        <p class="help-text">${isCompany
          ? 'This permanently removes your company profile, all postings, applications to them, interviews and conversations. Students will lose those applications.'
          : 'This permanently removes your profile, resume, skills, applications, interviews and conversations.'} It can't be undone.</p>
        <form id="delForm">
          <div class="field"><label>Enter your password to confirm</label><input class="input" id="delPw" type="password" required autocomplete="current-password"></div>
          <button class="btn btn-danger-solid" type="submit">Delete my account</button>
          <div class="error-text" id="delMsg"></div>
        </form>
      </section>
    </div>`;
    wire();
  }

  function wire() {
    const $ = (id) => root.querySelector('#' + id);

    // suggestions: schools that already have an approved coordinator
    if ($('schoolList')) api('/schools').then((list) => { $('schoolList').innerHTML = list.map((n) => `<option value="${esc(n)}">`).join(''); }).catch(() => {});
    $('detailsForm')?.addEventListener('submit', async (e) => {
      e.preventDefault(); clearMsg($('detailsMsg'));
      try {
        const body = { school: $('schoolInput').value, ...(isStudent ? { program: $('extraInput').value } : { position: $('extraInput').value }) };
        const user = await api('/account', { method: 'PATCH', token: token(), body });
        account = user; saveSession(user); showMsg($('detailsMsg'), 'Saved.', true);
      } catch (err) { showMsg($('detailsMsg'), err.message); }
    });
    $('emailPref').addEventListener('change', async (e) => {
      try {
        await api('/account', { method: 'PATCH', token: token(), body: { emailNotifications: e.target.checked } });
        account.email_notifications = e.target.checked ? 1 : 0;
        $('prefMsg').textContent = e.target.checked ? 'Email notifications are on.' : 'Email notifications are off.'; $('prefMsg').classList.add('show');
      } catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
    });

    $('nameForm').addEventListener('submit', async (e) => {
      e.preventDefault(); clearMsg($('nameMsg'));
      try {
        const user = await api('/account', { method: 'PATCH', token: token(), body: { name: $('nameInput').value } });
        account = user; saveSession(user); refreshChrome(user);
        showMsg($('nameMsg'), 'Name saved.', true);
      } catch (err) { showMsg($('nameMsg'), err.message); }
    });

    $('emailForm').addEventListener('submit', async (e) => {
      e.preventDefault(); clearMsg($('emailMsg'));
      try {
        await api('/account/email/request', { method: 'POST', token: token(), body: { newEmail: $('newEmail').value } });
        $('sentTo').textContent = $('newEmail').value.trim().toLowerCase();
        $('emailConfirm').style.display = ''; $('emailCode').focus();
        showMsg($('emailMsg'), 'Code sent — check the new inbox.', true);
      } catch (err) { showMsg($('emailMsg'), err.message); }
    });
    $('emailConfirm').addEventListener('submit', async (e) => {
      e.preventDefault(); clearMsg($('emailMsg'));
      try {
        const { user, token: fresh } = await api('/account/email/confirm', { method: 'POST', token: token(),
          body: { newEmail: $('newEmail').value, code: $('emailCode').value.trim(), password: $('emailPw').value } });
        saveSession(user, fresh); account = user;
        toast('Email updated. Use it the next time you log in.');
        render();
      } catch (err) { showMsg($('emailMsg'), err.message); }
    });

    $('pwForm').addEventListener('submit', async (e) => {
      e.preventDefault(); clearMsg($('pwMsg'));
      if ($('newPw').value !== $('newPw2').value) return showMsg($('pwMsg'), "The new passwords don't match.");
      try {
        await api('/account/password', { method: 'POST', token: token(), body: { currentPassword: $('curPw').value, newPassword: $('newPw').value } });
        e.target.reset(); showMsg($('pwMsg'), 'Password changed.', true);
      } catch (err) { showMsg($('pwMsg'), err.message); }
    });

    $('delForm').addEventListener('submit', async (e) => {
      e.preventDefault(); clearMsg($('delMsg'));
      if (!(await confirmDialog({ title: 'Delete your account permanently?', message: 'This cannot be undone.', confirmLabel: 'Delete my account' }))) return;
      try {
        await api('/account', { method: 'DELETE', token: token(), body: { password: $('delPw').value } });
        Session.clear();
        window.location.href = 'login.html';
      } catch (err) { showMsg($('delMsg'), err.message); }
    });
  }

  load().catch((err) => { root.innerHTML = `<div class="card"><div class="empty-state">Couldn't load your settings: ${esc(err.message)}</div></div>`; });
}
