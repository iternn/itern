// Shared "requirements" checklist: used on the Profile page (manage documents) and on the
// Matches page (the gate students must pass before an application is sent).
import { api, Session, API_BASE } from './api.js';
import { icon, esc, toast } from './nav.js';

const tok = () => ({ token: Session.token() });
export const getRequirements = () => api('/requirements/mine', tok());

async function sendFile(type, file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/requirements/${type}`, { method: 'POST', headers: { Authorization: `Bearer ${Session.token()}` }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed.');
  return data;
}

export async function openDoc(type) {
  try {
    const res = await fetch(`${API_BASE}/requirements/${type}/file`, { headers: { Authorization: `Bearer ${Session.token()}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not open the file.');
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) { toast(err.message); }
}

/**
 * Draws the checklist into `root` and keeps it up to date after each upload / removal.
 * `onChange(status)` fires every time the list is (re)drawn so the caller can enable / disable a button.
 */
export function mountChecklist(root, status, onChange = () => {}) {
  const draw = (st) => {
    status = st;
    root.innerHTML = st.items.map((it) => `
      <div class="req-row ${it.done ? 'ok' : 'todo'}">
        <span class="req-ico">${icon(it.done ? 'check' : 'alert', 16)}</span>
        <div class="req-main">
          <div class="req-name">${esc(it.label)}</div>
          <div class="req-sub">${it.done ? esc(it.fileName || 'On file') : esc(it.hint || '')}</div>
        </div>
        <div class="req-actions">
          ${it.onProfile
            ? (it.done ? '<span class="badge badge-strong">On file</span>' : '<a class="btn btn-ghost btn-sm" href="profile.html">Go to Profile</a>')
            : `${it.done ? `<button class="btn btn-ghost btn-sm" data-view="${it.key}" type="button">View</button>` : ''}
               <button class="btn ${it.done ? 'btn-ghost' : 'btn-primary'} btn-sm" data-pick="${it.key}" type="button">${it.done ? 'Replace' : 'Upload'}</button>
               <input type="file" data-file="${it.key}" accept="application/pdf,image/jpeg,image/png" hidden>`}
        </div>
      </div>`).join('');
    root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openDoc(b.dataset.view)));
    root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => root.querySelector(`[data-file="${b.dataset.pick}"]`).click()));
    root.querySelectorAll('[data-file]').forEach((inp) => inp.addEventListener('change', async () => {
      const file = inp.files[0]; if (!file) return;
      const btn = root.querySelector(`[data-pick="${inp.dataset.file}"]`);
      btn.disabled = true; btn.textContent = 'Uploading…';
      try { draw(await sendFile(inp.dataset.file, file)); }
      catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Upload'; }
    }));
    onChange(st);
  };
  draw(status);
}

/**
 * The gate shown when a student presses Apply. Nothing is sent until every requirement is on file
 * AND the student ticks the confirmation box.
 * `onSubmit()` should send the application; it may throw to keep the modal open.
 */
export async function openApplyGate({ backdrop, modal, posting, onSubmit }) {
  let status;
  try { status = await getRequirements(); } catch (err) { toast(err.message); return; }
  modal.innerHTML = `
    <h3 style="font-size:18px;">Before you apply</h3>
    <p style="margin:6px 0 14px;font-size:13.5px;color:var(--ink-500);line-height:1.5;">
      ${esc(posting.company_name)} will receive these documents with your application to <b>${esc(posting.title)}</b>.
      Submit everything on the list first — you only have to do this once; your files are reused for future applications.</p>
    <div id="gateList"></div>
    <p class="help-text" style="margin:8px 0 0;">PDF, JPG or PNG · up to 5MB each</p>
    <label class="gate-confirm"><input type="checkbox" id="gateConfirm"> <span>I confirm these documents are mine and are accurate.</span></label>
    <div class="error-text" id="gateErr"></div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button class="btn btn-ghost" id="gateCancel" type="button">Cancel</button>
      <button class="btn btn-primary btn-block" id="gateSubmit" type="button" disabled>Submit application</button>
    </div>`;
  const submit = modal.querySelector('#gateSubmit');
  const confirm = modal.querySelector('#gateConfirm');
  const refresh = () => { submit.disabled = !(status.complete && confirm.checked); };
  mountChecklist(modal.querySelector('#gateList'), status, (st) => { status = st; refresh(); });
  confirm.addEventListener('change', refresh);
  modal.querySelector('#gateCancel').addEventListener('click', () => backdrop.classList.remove('open'));
  submit.addEventListener('click', async () => {
    submit.disabled = true; submit.textContent = 'Submitting…';
    try { await onSubmit(); }
    catch (err) {
      const e = modal.querySelector('#gateErr'); e.textContent = err.message; e.classList.add('show');
      submit.textContent = 'Submit application'; refresh();
    }
  });
  backdrop.classList.add('open');
}
