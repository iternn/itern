// Account actions for the admin console (approve / reject / suspend / reinstate / delete), shared by two pages.
import { api, Session } from './api.js';
import { esc, toast } from './nav.js';
import { askReason } from './viewer.js';
import { confirmDialog } from './dialog.js';

const ACTIONS = {
  Pending:   [['Approve', 'Approved', 'primary'], ['Reject', 'Rejected', 'ghost']],
  Approved:  [['Suspend', 'Suspended', 'ghost'], ['Delete', 'delete', 'danger']],
  Rejected:  [['Approve', 'Approved', 'primary'], ['Delete', 'delete', 'danger']],
  Suspended: [['Reinstate', 'Approved', 'primary'], ['Delete', 'delete', 'danger']],
};

export const actionButtons = (a) => (ACTIONS[a.account_status] || []).map(([label, to, tone]) =>
  `<button class="btn btn-${tone} btn-sm" data-act="${to}" data-id="${a.id}" data-name="${esc(a.name)}" type="button">${label}</button>`).join(' ');

/** Wires the buttons produced by actionButtons() inside `root`. `onDone` reloads the list afterwards. */
export function wireActions(root, role, onDone) {
  root.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
    const { act, id, name } = btn.dataset;
    try {
      if (act === 'delete') {
        if (!(await confirmDialog({ title: `Permanently delete ${name}?`, message: 'This removes the account and everything attached to it (postings, applications, messages, uploaded files). It cannot be undone.', confirmLabel: 'Delete account' }))) return;
        await api(`/admin/accounts/${role}/${id}`, { method: 'DELETE', token: Session.token() });
        toast(`${name} was deleted.`);
      } else {
        let note = '';
        if (act === 'Rejected' || act === 'Suspended') {
          note = await askReason({ title: `${act === 'Rejected' ? 'Reject' : 'Suspend'} ${name}?`,
            intro: 'They will see this reason when they try to log in.', placeholder: act === 'Rejected' ? 'e.g., We could not verify this company' : 'e.g., Reported for spam',
            confirmLabel: act === 'Rejected' ? 'Reject' : 'Suspend' });
          if (!note) return;
        }
        await api(`/admin/accounts/${role}/${id}/status`, { method: 'PATCH', token: Session.token(), body: { status: act, note } });
        toast(`${name}: ${act === 'Approved' ? 'approved' : act.toLowerCase()}.`);
      }
      onDone();
    } catch (err) { toast(err.message); }
  }));
}
