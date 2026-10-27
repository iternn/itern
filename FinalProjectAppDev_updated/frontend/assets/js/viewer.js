// Small popups shared by OJT documents, certificates and chat: a file viewer and an "ask for a reason" dialog.
import { API_BASE, Session } from './api.js';
import { esc, toast } from './nav.js';

/** Fetches a protected file with the login token (plain links can't send it). */
export async function fetchBlob(path) {
  const res = await fetch(API_BASE + path, { headers: { Authorization: `Bearer ${Session.token()}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not open the file.');
  return res.blob();
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name || 'file' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function popup(html) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop open';
  back.innerHTML = html;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  return { back, close };
}

/** Opens a PDF / image in an in-page viewer (anything else is downloaded). */
export async function viewFile(path, name) {
  try {
    const blob = await fetchBlob(path);
    if (!blob.type.startsWith('image/') && blob.type !== 'application/pdf') return saveBlob(blob, name);
    const url = URL.createObjectURL(blob);
    const { back, close } = popup(`<div class="modal pdf-modal">
      <div style="display:flex;align-items:center;gap:10px;">
        <h3 style="flex:1;font-size:15px;word-break:break-all;">${esc(name || 'File')}</h3>
        <button class="btn btn-ghost btn-sm" data-dl type="button">Download</button>
        <button class="btn btn-primary btn-sm" data-close type="button">Close</button>
      </div>
      ${blob.type === 'application/pdf' ? `<iframe src="${url}" title="${esc(name || 'File')}"></iframe>` : `<div class="img-wrap"><img src="${url}" alt="${esc(name || '')}"></div>`}
    </div>`);
    back.querySelector('[data-close]').addEventListener('click', () => { close(); URL.revokeObjectURL(url); });
    back.querySelector('[data-dl]').addEventListener('click', () => saveBlob(blob, name));
  } catch (err) { toast(err.message); }
}

export async function downloadFile(path, name) {
  try { saveBlob(await fetchBlob(path), name); } catch (err) { toast(err.message); }
}

/** Resolves with the typed reason, or null if cancelled. */
export function askReason({ title, intro = '', placeholder = '', confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const { back, close } = popup(`<div class="modal">
      <h3>${esc(title)}</h3>
      ${intro ? `<p style="margin:6px 0 14px;font-size:13.5px;color:var(--ink-500);">${esc(intro)}</p>` : ''}
      <div class="field"><textarea class="input" id="reasonBox" rows="3" placeholder="${esc(placeholder)}"></textarea></div>
      <div class="error-text" id="reasonErr"></div>
      <div style="display:flex;gap:10px;margin-top:8px;">
        <button class="btn btn-ghost" data-cancel type="button" style="flex-shrink:0;white-space:nowrap;">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block" data-ok type="button">${esc(confirmLabel)}</button>
      </div></div>`);
    const box = back.querySelector('#reasonBox'); box.focus();
    const done = (v) => { close(); resolve(v); };
    back.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    back.addEventListener('click', (e) => { if (e.target === back) resolve(null); });
    back.querySelector('[data-ok]').addEventListener('click', () => {
      const v = box.value.trim();
      if (v.length < 3) { const err = back.querySelector('#reasonErr'); err.textContent = 'Please write a few words.'; err.classList.add('show'); return; }
      done(v);
    });
  });
}
