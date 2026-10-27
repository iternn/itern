// OJT tracker UI, shared by the three portals:
//   student     -> logs hours, uploads documents, downloads the certificate
//   company     -> approves hours, uploads the evaluation form, reviews documents (if the school has no coordinator)
//   coordinator -> reviews documents, sees hours (read-only), downloads the certificate
import { api, Session, API_BASE } from './api.js';
import { esc, icon, statusPill, fmtDate, toast } from './nav.js';
import { durationLabel, scheduleLabel, fmtDay } from './posting.js';
import { viewFile, downloadFile, askReason } from './viewer.js';
import { confirmDialog } from './dialog.js';

const num = (n) => Number(n || 0).toFixed(2).replace(/\.?0+$/, '');
const todayLocal = () => new Date().toLocaleDateString('en-CA');

export function mountOjt({ portal, root }) {
  const token = () => Session.token();
  const role = portal === 'student' ? 'intern' : portal;
  const st = { list: [], detail: null, tab: 'hours', editing: null, q: '' };

  const get = (path) => api(path, { token: token() });
  const send = (path, method, body) => api(path, { method, token: token(), body });

  /* ============================== list (company + coordinator) ============================== */

  function renderList() {
    const q = st.q.trim().toLowerCase();
    const rows = st.list.filter((p) => !q || p.student.name.toLowerCase().includes(q) || p.company.name.toLowerCase().includes(q) || p.posting.title.toLowerCase().includes(q));
    root.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>${portal === 'company' ? 'Your interns' : 'Students on placement'}</h3>
          <input class="input" id="ojtSearch" placeholder="Search…" value="${esc(st.q)}" style="max-width:260px;"></div>
        <div style="overflow-x:auto;"><table class="data-table"><thead><tr>
          <th>Student</th><th>${portal === 'company' ? 'Position' : 'Company'}</th><th style="min-width:180px;">Hours</th><th>Needs attention</th><th>Documents</th><th>Status</th><th></th>
        </tr></thead><tbody>${rows.map((p) => `
          <tr>
            <td><b>${esc(p.student.name)}</b><div class="row-sub">${esc([p.student.program, portal === 'company' ? p.student.school : ''].filter(Boolean).join(' · '))}</div></td>
            <td>${esc(portal === 'company' ? p.posting.title : p.company.name)}${portal === 'coordinator' ? `<div class="row-sub">${esc(p.posting.title)}</div>` : ''}</td>
            <td>${meter(p)}</td>
            <td>${p.hours.pendingEntries ? `<span class="chip amber">${num(p.hours.pending)} h to approve</span>` : ''}${p.docs.submitted ? ` <span class="chip blue">${p.docs.submitted} doc${p.docs.submitted === 1 ? '' : 's'} to review</span>` : ''}${!p.hours.pendingEntries && !p.docs.submitted ? '<span class="row-sub">—</span>' : ''}</td>
            <td>${p.docs.approved} / ${p.docs.total} approved</td>
            <td>${statusPill(p.completedAt ? 'Completed' : 'In progress')}</td>
            <td><button class="btn btn-ghost btn-sm" data-open="${p.id}" type="button">Open</button></td>
          </tr>`).join('') || `<tr><td colspan="7"><div class="empty-state">${st.list.length ? 'No one matches your search.'
            : portal === 'company' ? 'No interns yet. When a student accepts your offer, they appear here with their hours and documents.'
            : 'No placements yet. When students from your school accept an offer, they appear here.'}</div></td></tr>`}
        </tbody></table></div>
      </div>`;
    root.querySelector('#ojtSearch').addEventListener('input', (e) => { st.q = e.target.value; const pos = e.target.selectionStart; renderList(); const i = root.querySelector('#ojtSearch'); i.focus(); i.setSelectionRange(pos, pos); });
    root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openDetail(b.dataset.open)));
  }

  const meter = (p) => p.hours.required
    ? `<div class="meter ${p.hours.percent >= 100 ? 'done' : ''}"><i style="width:${p.hours.percent}%"></i></div><div class="row-sub" style="margin-top:4px;">${num(p.hours.approved)} / ${p.hours.required} h · ${p.hours.percent}%</div>`
    : `<div class="row-sub"><b style="color:var(--ink-900);">${num(p.hours.approved)} h</b> approved</div>`;

  /* ============================== detail ============================== */

  async function openDetail(id, { keepTab = false } = {}) {
    st.detail = await get(`/ojt/placements/${id}`);
    if (!keepTab) { st.tab = 'hours'; st.editing = null; }
    renderDetail();
  }

  function renderDetail() {
    const d = st.detail, p = d.posting;
    const canGoBack = portal !== 'student';
    root.innerHTML = `
      ${canGoBack ? '<button class="btn btn-ghost btn-sm" id="ojtBack" type="button" style="margin-bottom:14px;">← All ' + (portal === 'company' ? 'interns' : 'students') + '</button>' : ''}
      <div class="card" id="ojtHeader"></div>
      <div class="tabs" id="ojtTabs"></div>
      <div id="ojtPane"></div>`;
    root.querySelector('#ojtBack')?.addEventListener('click', () => { st.detail = null; load(); });
    paintHeader(); paintTabs(); paintPane(true);
  }

  function paintHeader() {
    const d = st.detail, p = d.posting, h = d.hours;
    const who = portal === 'student' ? `${d.company.name} · ${p.title}` : `${d.student.name} · ${d.student.program || ''}${d.student.school ? ' · ' + d.student.school : ''}`;
    root.querySelector('#ojtHeader').innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div><div class="eyebrow-sm">${portal === 'student' ? 'YOUR PLACEMENT' : portal === 'company' ? 'INTERN' : 'STUDENT PLACEMENT'}</div>
          <h2 style="font-size:20px;margin:2px 0 4px;">${esc(portal === 'student' ? p.title : d.student.name)}</h2>
          <div class="row-sub">${esc(portal === 'student' ? d.company.name : `${p.title} · ${d.company.name}`)}${portal !== 'student' && d.student.school ? ` · ${esc(d.student.school)}` : ''}</div>
          <div class="chips">${p.program_type ? `<span class="chip violet">${esc(p.program_type)}</span>` : ''}${durationLabel(p) ? `<span class="chip">${esc(durationLabel(p))}</span>` : ''}${scheduleLabel(p) ? `<span class="chip">${esc(scheduleLabel(p))}</span>` : ''}${p.location ? `<span class="chip">${esc(p.location)}</span>` : ''}</div></div>
        <div>${statusPill(d.completedAt ? 'Completed' : 'In progress')}</div>
      </div>
      <div style="margin-top:18px;">
        ${h.required ? `<div class="meter ${h.percent >= 100 ? 'done' : ''}"><i style="width:${h.percent}%"></i></div>` : ''}
        <div class="mini-stats">
          <div><b>${num(h.approved)}${h.required ? ` / ${h.required}` : ''}</b>hours approved${h.required ? ` (${h.percent}%)` : ''}</div>
          <div><b>${num(h.pending)}</b>awaiting approval</div>
          ${h.required ? `<div><b>${num(Math.max(0, h.required - h.approved))}</b>hours remaining</div>` : ''}
          <div><b>${d.docs.approved} / ${d.docs.total}</b>documents approved</div>
        </div>
      </div>`;
  }

  function paintTabs() {
    const d = st.detail;
    const tabs = [['hours', 'Hours', d.hours.pendingEntries && portal === 'company' ? d.hours.pendingEntries : 0],
      ['docs', 'Documents', d.documents.filter((x) => x.canReview).length],
      ['cert', 'Certificate', 0]];
    root.querySelector('#ojtTabs').innerHTML = tabs.map(([k, label, n]) =>
      `<button class="tab ${st.tab === k ? 'active' : ''}" data-tab="${k}" type="button">${label}${n ? ` <span class="chip amber count">${n}</span>` : ''}</button>`).join('');
    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { st.tab = b.dataset.tab; paintTabs(); paintPane(true); }));
  }

  // fresh = rebuild the whole pane; otherwise only refresh the lists (so a half-typed hours form survives live updates)
  function paintPane(fresh) {
    const pane = root.querySelector('#ojtPane');
    if (st.tab === 'hours') paintHours(pane, fresh);
    else if (st.tab === 'docs') paintDocs(pane);
    else paintCert(pane);
  }

  /* ---------- hours ---------- */

  function paintHours(pane, fresh) {
    const d = st.detail;
    if (fresh || !pane.querySelector('#hoursTable')) {
      pane.innerHTML = `
        ${portal === 'student' && !d.completedAt ? `<div class="card" style="margin-bottom:16px;" id="hoursFormCard">
          <div class="card-head"><h3 id="hoursFormTitle">Log your hours</h3></div>
          <form id="hoursForm" class="row3" style="align-items:end;" novalidate>
            <div class="field"><label>Date</label><input class="input" id="hDate" type="date" max="${todayLocal()}" ${d.posting.start_date ? `min="${d.posting.start_date}"` : ''} value="${todayLocal()}" required></div>
            <div class="field"><label>Hours</label><input class="input" id="hHours" type="number" step="0.25" min="0.25" max="12" placeholder="e.g., 8" required></div>
            <div class="field"><label>What did you work on?</label><input class="input" id="hNotes" maxlength="255" placeholder="e.g., Built the login page" required></div>
            <div style="grid-column:1/-1;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
              <button class="btn btn-primary" id="hSave" type="submit">Add hours</button>
              <button class="btn btn-ghost" id="hCancel" type="button" style="display:none;">Cancel edit</button>
              <span class="help-text" style="margin:0;">Your company approves each entry. Up to 12 hours a day, in 15-minute steps.</span>
            </div>
            <div class="error-text" id="hErr" style="grid-column:1/-1;"></div>
          </form></div>` : ''}
        <div class="card"><div class="card-head"><h3>Hours log</h3>
          ${portal === 'company' && d.hours.pendingEntries ? `<button class="btn btn-primary btn-sm" id="approveAll" type="button">Approve all pending (${d.hours.pendingEntries})</button>` : ''}</div>
          <div style="overflow-x:auto;"><table class="data-table"><thead><tr><th>Date</th><th>Hours</th><th>Notes</th><th>Status</th><th></th></tr></thead>
          <tbody id="hoursTable"></tbody></table></div></div>`;
      wireHoursForm();
      pane.querySelector('#approveAll')?.addEventListener('click', async () => {
        try { const r = await send(`/ojt/placements/${d.id}/hours/approve-all`, 'POST'); toast(`Approved ${num(r.hours)} hours.`); refresh(); } catch (e) { toast(e.message); }
      });
    }
    pane.querySelector('#hoursTable').innerHTML = d.hoursLog.map((l) => `
      <tr><td>${esc(fmtDay(l.date))}</td><td><b>${num(l.hours)}</b></td>
        <td>${esc(l.notes || '')}${l.status === 'Rejected' && l.reviewerNote ? `<div class="row-sub" style="color:var(--rose-500);">Not approved: ${esc(l.reviewerNote)}</div>` : ''}</td>
        <td>${statusPill(l.status)}</td>
        <td style="white-space:nowrap;">
          ${portal === 'company' && l.status === 'Pending' ? `<button class="btn btn-primary btn-sm" data-approve="${l.id}" type="button">Approve</button> <button class="btn btn-ghost btn-sm" data-reject="${l.id}" type="button">Reject</button>` : ''}
          ${portal === 'student' && l.status !== 'Approved' && !d.completedAt ? `<button class="btn btn-ghost btn-sm" data-edit="${l.id}" type="button">Edit</button> <button class="btn btn-ghost btn-sm" data-del="${l.id}" type="button">Delete</button>` : ''}
        </td></tr>`).join('') || `<tr><td colspan="5"><div class="empty-state">${portal === 'student' ? 'No hours logged yet. Add your first entry above.' : 'No hours logged yet.'}</div></td></tr>`;

    pane.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      try { await send(`/ojt/hours/${b.dataset.approve}/review`, 'PATCH', { decision: 'Approve' }); refresh(); } catch (e) { toast(e.message); }
    }));
    pane.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
      const note = await askReason({ title: 'Reject these hours?', intro: 'The student will see your reason and can correct the entry.', placeholder: 'e.g., You were on leave that day', confirmLabel: 'Reject hours' });
      if (!note) return;
      try { await send(`/ojt/hours/${b.dataset.reject}/review`, 'PATCH', { decision: 'Reject', note }); refresh(); } catch (e) { toast(e.message); }
    }));
    pane.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Delete this entry?', message: 'This hours entry will be removed.', confirmLabel: 'Delete' }))) return;
      try { await send(`/ojt/hours/${b.dataset.del}`, 'DELETE'); refresh(); } catch (e) { toast(e.message); }
    }));
    pane.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const l = d.hoursLog.find((x) => x.id === b.dataset.edit);
      st.editing = l.id;
      pane.querySelector('#hDate').value = l.date; pane.querySelector('#hHours').value = l.hours; pane.querySelector('#hNotes').value = l.notes || '';
      pane.querySelector('#hoursFormTitle').textContent = 'Edit entry'; pane.querySelector('#hSave').textContent = 'Save changes';
      pane.querySelector('#hCancel').style.display = ''; pane.querySelector('#hoursFormCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  }

  function wireHoursForm() {
    const form = root.querySelector('#hoursForm');
    if (!form) return;
    const reset = () => {
      st.editing = null; form.reset(); form.querySelector('#hDate').value = todayLocal();
      root.querySelector('#hoursFormTitle').textContent = 'Log your hours'; form.querySelector('#hSave').textContent = 'Add hours'; form.querySelector('#hCancel').style.display = 'none';
    };
    form.querySelector('#hCancel').addEventListener('click', reset);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('#hErr'); err.classList.remove('show');
      const body = { date: form.querySelector('#hDate').value, hours: Number(form.querySelector('#hHours').value), notes: form.querySelector('#hNotes').value };
      form.querySelector('#hSave').disabled = true;
      try {
        if (st.editing) await send(`/ojt/hours/${st.editing}`, 'PATCH', body);
        else await send(`/ojt/placements/${st.detail.id}/hours`, 'POST', body);
        toast(st.editing ? 'Entry updated.' : 'Hours added — waiting for your company to approve.');
        reset(); refresh();
      } catch (ex) { err.textContent = ex.message; err.classList.add('show'); }
      finally { form.querySelector('#hSave').disabled = false; }
    });
  }

  /* ---------- documents ---------- */

  function paintDocs(pane) {
    const d = st.detail;
    const reviewerName = d.reviewer === 'coordinator' ? 'your school coordinator' : 'the host company';
    pane.innerHTML = `<div class="card">
      <div class="card-head"><h3>Document checklist</h3><span class="row-sub">Reviewed by ${portal === 'coordinator' && d.reviewer === 'coordinator' ? 'you' : portal === 'company' && d.reviewer === 'company' ? 'you' : esc(reviewerName)}</span></div>
      ${d.documents.map((doc) => `
        <div class="doc-row">
          <div class="doc-icon ${doc.status === 'Approved' ? 'ok' : ''}">${icon(doc.status === 'Approved' ? 'check' : 'file', 18)}</div>
          <div style="flex:1;min-width:200px;">
            <div class="row-title">${esc(doc.label)} ${statusPill(doc.status)}</div>
            <div class="row-sub">${esc(doc.fileName ? `${doc.fileName} · uploaded by ${doc.uploadedBy === 'intern' ? 'the student' : doc.uploadedBy}` : doc.hint)}</div>
            ${doc.status === 'Rejected' && doc.note ? `<div class="row-sub" style="color:var(--rose-500);">Needs changes: ${esc(doc.note)}</div>` : ''}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${doc.id ? `<button class="btn btn-ghost btn-sm" data-view="${doc.id}" data-name="${esc(doc.fileName)}" type="button">View</button>` : ''}
            ${doc.canUpload ? `<button class="btn ${doc.status === 'Missing' || doc.status === 'Rejected' ? 'btn-primary' : 'btn-ghost'} btn-sm" data-upload="${doc.type}" type="button">${doc.id ? 'Replace' : 'Upload'}</button>` : ''}
            ${doc.canReview ? `<button class="btn btn-primary btn-sm" data-ok="${doc.id}" type="button">Approve</button><button class="btn btn-ghost btn-sm" data-no="${doc.id}" type="button">Request changes</button>` : ''}
          </div>
        </div>`).join('')}
      <input type="file" id="docInput" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/*" hidden>
      <p class="help-text" style="margin-top:12px;">PDF, JPG or PNG up to 10 MB. The evaluation form and approved hours unlock the completion certificate.</p>
    </div>`;
    const input = pane.querySelector('#docInput'); let type = null;
    pane.querySelectorAll('[data-upload]').forEach((b) => b.addEventListener('click', () => { type = b.dataset.upload; input.click(); }));
    input.addEventListener('change', async () => {
      const file = input.files[0]; input.value = '';
      if (!file || !type) return;
      const form = new FormData(); form.append('file', file);
      try {
        const res = await fetch(`${API_BASE}/ojt/placements/${d.id}/documents/${type}`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Upload failed.');
        toast(data.status === 'Approved' ? 'Uploaded and approved.' : 'Uploaded — waiting for review.'); refresh();
      } catch (err) { toast(err.message); }
    });
    pane.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewFile(`/ojt/documents/${b.dataset.view}/file`, b.dataset.name)));
    pane.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
      try { await send(`/ojt/documents/${b.dataset.ok}/review`, 'PATCH', { decision: 'Approve' }); toast('Document approved.'); refresh(); } catch (e) { toast(e.message); }
    }));
    pane.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', async () => {
      const note = await askReason({ title: 'Request changes', intro: 'Tell them what needs to be fixed. They can upload a new version.', placeholder: 'e.g., The signature page is missing', confirmLabel: 'Send feedback' });
      if (!note) return;
      try { await send(`/ojt/documents/${b.dataset.no}/review`, 'PATCH', { decision: 'Reject', note }); refresh(); } catch (e) { toast(e.message); }
    }));
  }

  /* ---------- certificate ---------- */

  function paintCert(pane) {
    const d = st.detail, c = d.completion, h = d.hours;
    const line = (ok, text) => `<div class="req-line"><span class="dot ${ok ? 'ok' : ''}">${ok ? '✓' : ''}</span><span>${text}</span></div>`;
    pane.innerHTML = `<div class="card">
      <div class="card-head"><h3>Completion certificate</h3>${c.certificateReady ? statusPill('Completed') : ''}</div>
      ${c.certificateReady ? `
        <p style="font-size:14px;margin:0 0 16px;">${portal === 'student' ? '🎉 Congratulations! You completed your placement' : 'This placement is complete'}${d.completedAt ? ` on <b>${esc(fmtDate(d.completedAt))}</b>` : ''}. The certificate is ready.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-primary" id="certView" type="button">${icon('award', 16)} View certificate</button>
          <button class="btn btn-ghost" id="certDl" type="button">${icon('download', 16)} Download PDF</button></div>`
      : `<p style="font-size:14px;color:var(--ink-500);margin:0 0 10px;">The certificate unlocks automatically when both of these are done:</p>
        ${line(c.hoursDone, h.required ? `All required hours approved <b>(${num(h.approved)} / ${h.required})</b>` : 'The placement has ended and hours were approved')}
        ${line(c.evaluationApproved, 'Evaluation form uploaded and approved')}`}
    </div>`;
    const name = `ITern-Certificate-${d.student.name.replace(/\W+/g, '_')}.pdf`;
    pane.querySelector('#certView')?.addEventListener('click', () => viewFile(`/ojt/placements/${d.id}/certificate`, name));
    pane.querySelector('#certDl')?.addEventListener('click', () => downloadFile(`/ojt/placements/${d.id}/certificate?download=1`, name));
  }

  /* ============================== loading ============================== */

  async function refresh() {
    if (st.detail) { const id = st.detail.id; try { st.detail = await get(`/ojt/placements/${id}`); } catch { st.detail = null; return load(); }
      paintHeader(); paintTabs(); paintPane(st.tab !== 'hours'); }
    else await load();
  }

  async function load() {
    st.list = await get('/ojt/placements');
    if (portal === 'student') {
      if (!st.list.length) {
        root.innerHTML = `<div class="card"><div class="empty-state" style="padding:36px 20px;">
          <div class="stat-icon tone-violet" style="margin:0 auto 12px;">${icon('clock', 18)}</div>
          <b style="display:block;font-size:15px;color:var(--ink-900);margin-bottom:4px;">No active placement yet</b>
          Once you accept an offer, you can log your hours, upload your documents and earn your completion certificate here.<br>
          <a class="btn btn-primary btn-sm" href="applications.html" style="margin-top:14px;">See my applications</a></div></div>`;
        return;
      }
      const wanted = new URLSearchParams(location.search).get('open') || st.list[0].id;
      return openDetail(st.list.find((p) => p.id === wanted)?.id || st.list[0].id, { keepTab: true });
    }
    const open = new URLSearchParams(location.search).get('open');
    if (open && !st.detail && st.list.some((p) => p.id === open)) { history.replaceState(null, '', location.pathname); return openDetail(open); }
    renderList();
  }

  // live updates (someone approved your hours, uploaded a document ...)
  let timer;
  window.addEventListener('itern:live', (e) => {
    if (!['ojt:changed', 'resync'].includes(e.detail.name)) return;
    clearTimeout(timer); timer = setTimeout(() => refresh().catch(() => {}), 400);
  });

  load().catch((err) => { root.innerHTML = `<div class="card"><div class="empty-state">${esc(err.message)}</div></div>`; });
}
