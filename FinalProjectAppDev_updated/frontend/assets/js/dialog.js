// In-app replacements for the browser's confirm() / alert() pop-ups.
// No dependencies, so any page can import it.
//   if (!(await confirmDialog({ title: 'Withdraw application?', message: '...', confirmLabel: 'Withdraw' }))) return;
//   await alertDialog('Registration failed: ...');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function open(html) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop open';
  back.style.zIndex = 10000;
  back.innerHTML = `<div class="modal dialog-box" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  return back;
}

/** Resolves true if the user confirms, false if they cancel (button, backdrop click or Esc). */
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    const back = open(`
      <h3 style="font-size:17px;margin:0;">${esc(title)}</h3>
      ${message ? `<p class="dialog-msg">${esc(message)}</p>` : ''}
      <div class="dialog-actions">
        <button class="btn btn-ghost" data-no type="button">${esc(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-yes type="button">${esc(confirmLabel)}</button>
      </div>`);
    const done = (v) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => { if (e.target === back) done(false); });
    back.querySelector('[data-no]').addEventListener('click', () => done(false));
    back.querySelector('[data-yes]').addEventListener('click', () => done(true));
    back.querySelector(danger ? '[data-no]' : '[data-yes]').focus(); // the safe choice is focused for destructive actions
  });
}

/** A one-button message box. Resolves when it is closed. */
export function alertDialog(message, title = 'Notice') {
  return new Promise((resolve) => {
    const back = open(`
      <h3 style="font-size:17px;margin:0;">${esc(title)}</h3>
      <p class="dialog-msg">${esc(message)}</p>
      <div class="dialog-actions"><button class="btn btn-primary" data-ok type="button">OK</button></div>`);
    const done = () => { document.removeEventListener('keydown', onKey); back.remove(); resolve(); };
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') done(); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => { if (e.target === back) done(); });
    back.querySelector('[data-ok]').addEventListener('click', done);
    back.querySelector('[data-ok]').focus();
  });
}
