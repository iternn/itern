// Shared chat UI for the student and company portals.
// Usage (from messages.html):  mountMessages({ portal: 'student' | 'company', root: element })
import { api, Session, assetUrl, API_BASE } from './api.js';
import { viewFile, fetchBlob } from './viewer.js';
import { icon, esc, initialsOf, safeLink, fmtDateTime, toast } from './nav.js';

const MAX_LEN = 2000;
const FILE_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'doc', 'docx', 'txt'];
const fmtSize = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
const thumbs = new Map(); // message id -> blob URL (so images aren't re-downloaded on every redraw)

export function mountMessages({ portal, root }) {
  const token = () => Session.token();
  const meType = portal === 'company' ? 'company' : 'intern';

  const st = {
    conversations: [],
    contacts: [],
    active: null,        // { conversationId|null, other: {id,name,subtitle,photo,positions?} }
    messages: [],
    otherReadUpTo: 0,
    sending: false,
    file: null,
    tmp: 0,
  };

  root.innerHTML = `
    <div class="card chat-shell" id="chatShell">
      <section class="chat-list">
        <div class="chat-list__head">
          <div class="chat-list__title"><h3>Conversations</h3>
            <button class="btn btn-primary btn-sm" id="newMsgBtn" type="button">${icon('plus', 14)} New</button></div>
          <input class="input" id="chatSearch" placeholder="Search conversations…" autocomplete="off">
        </div>
        <div class="chat-list__items" id="chatItems"></div>
      </section>
      <section class="chat-pane" id="chatPane"></section>
    </div>
    <div class="modal-backdrop" id="contactsBackdrop"><div class="modal" id="contactsModal"></div></div>`;

  const $ = (id) => root.querySelector('#' + id);
  const shell = $('chatShell'), itemsEl = $('chatItems'), paneEl = $('chatPane');

  /* ---------------- small render helpers ---------------- */
  const avatar = (other, size) => {
    const inner = other.photo ? `<img src="${assetUrl(other.photo)}" alt="">` : esc(initialsOf(other.name));
    return `<div class="chat-avatar" ${size ? `style="width:${size}px;height:${size}px;"` : ''}>${inner}</div>`;
  };
  const timeShort = (d) => {
    const dt = new Date(d), now = new Date();
    if (dt.toDateString() === now.toDateString()) return dt.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    const diff = (now - dt) / 86400000;
    if (diff < 6) return dt.toLocaleDateString('en-PH', { weekday: 'short' });
    return dt.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  };
  const dayLabel = (d) => {
    const dt = new Date(d), now = new Date(), y = new Date(); y.setDate(now.getDate() - 1);
    if (dt.toDateString() === now.toDateString()) return 'Today';
    if (dt.toDateString() === y.toDateString()) return 'Yesterday';
    return dt.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' });
  };
  // Escape first, THEN turn URLs into links — so message text can never inject HTML.
  const linkify = (text) => esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  const previewOf = (c) => {
    const m = c.lastMessage;
    if (!m || !m.kind) return 'No messages yet';
    if (m.kind === 'interview') return 'Interview scheduled';
    if (m.kind === 'system') return m.body;
    return (m.senderType === meType ? 'You: ' : '') + (m.kind === 'file' ? `📎 ${m.body || 'Attachment'}` : m.body);
  };

  /* ---------------- conversation list ---------------- */
  function renderList() {
    const q = $('chatSearch').value.trim().toLowerCase();
    const rows = st.conversations.filter((c) => !q || c.other.name.toLowerCase().includes(q));
    itemsEl.innerHTML = rows.map((c) => `
      <div class="chat-item ${c.unread ? 'unread' : ''} ${st.active?.conversationId === c.id ? 'active' : ''}" data-id="${c.id}">
        ${avatar(c.other)}
        <div class="chat-item__body">
          <div class="chat-item__top"><span class="chat-item__name">${esc(c.other.name)}</span><span class="chat-item__time">${timeShort(c.lastMessageAt)}</span></div>
          <div class="chat-item__preview">${esc(previewOf(c))}</div>
        </div>
        ${c.unread ? `<span class="chat-unread">${c.unread}</span>` : ''}
      </div>`).join('') || `<div class="empty-state">${st.conversations.length
        ? 'No conversations match your search.'
        : (portal === 'company'
            ? 'No conversations yet. Once students apply to your postings you can message them here.'
            : 'No conversations yet. Apply to an internship, then message the company here.')}</div>`;
    itemsEl.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
      const c = st.conversations.find((x) => x.id === el.dataset.id);
      if (c) openConversation(c.id, c.other);
    }));
  }

  async function refreshList() {
    st.conversations = await api('/messages/conversations', { token: token() });
    // A draft that has since become a real conversation -> adopt it.
    if (st.active && !st.active.conversationId) {
      const found = st.conversations.find((c) => c.other.id === st.active.other.id);
      if (found) st.active.conversationId = found.id;
    }
    renderList();
    window.dispatchEvent(new CustomEvent('itern:unread-changed'));
  }

  /* ---------------- thread ---------------- */
  function renderPane() {
    const a = st.active;
    if (!a) {
      paneEl.innerHTML = `<div class="chat-empty"><div class="stat-icon tone-violet">${icon('chat', 18)}</div>
        <b>Select a conversation</b>${portal === 'company'
          ? 'Pick an applicant on the left, or start a new message.'
          : 'Pick a company on the left, or start a new message to a company you applied to.'}</div>`;
      return;
    }
    const profileLink = portal === 'student'
      ? `<a class="btn btn-ghost btn-sm" href="company-profile.html?id=${encodeURIComponent(a.other.id)}">View company</a>`
      : `<a class="btn btn-ghost btn-sm" href="applicants.html?q=${encodeURIComponent(a.other.name)}">View applicant</a>`;
    paneEl.innerHTML = `
      <div class="chat-pane__head">
        <button class="chat-back" id="chatBack" type="button" aria-label="Back to conversations">${icon('back', 16)}</button>
        ${avatar(a.other)}
        <div class="who"><b>${esc(a.other.name)}</b><small>${esc(a.other.positions ? `Applied: ${a.other.positions}` : a.other.subtitle)}</small></div>
        ${profileLink}
      </div>
      <div class="chat-scroll" id="chatScroll"></div>
      <div class="attach-chip" id="attachChip" style="display:none;"></div>
      <div class="chat-composer">
        <button class="btn btn-ghost" id="attachBtn" type="button" title="Attach a file (PDF, image, Word — up to 10 MB)" aria-label="Attach a file" style="padding:0 12px;">${icon('paperclip', 16)}</button>
        <input type="file" id="fileInput" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.txt">
        <textarea class="input" id="chatInput" rows="1" placeholder="Write a message…" maxlength="${MAX_LEN + 200}"></textarea>
        <button class="btn btn-primary" id="chatSend" type="button">${icon('send', 15)} Send</button>
      </div>
      <div class="chat-hint"><span id="chatHint">Enter to send · Shift+Enter for a new line</span><span id="chatCount"></span></div>`;
    $('chatBack').addEventListener('click', () => { shell.classList.remove('thread-open'); window.__iternActiveChat = null; });
    const input = $('chatInput');
    input.addEventListener('input', () => { autosize(); updateCount(); signalTyping(); });
    $('attachBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const ext = f.name.split('.').pop().toLowerCase();
      if (!FILE_EXTS.includes(ext)) return toast(`Allowed files: ${FILE_EXTS.join(', ').toUpperCase()}.`);
      if (f.size > 10 * 1024 * 1024) return toast('That file is over 10 MB.');
      st.file = f; paintChip();
    });
    paintChip();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $('chatSend').addEventListener('click', send);
    renderMessages(true);
  }

  /* ---------------- attachments + typing ---------------- */
  function paintChip() {
    const chip = $('attachChip');
    if (!chip) return;
    chip.style.display = st.file ? 'flex' : 'none';
    chip.innerHTML = st.file ? `${icon('paperclip', 14)}<span class="name">${esc(st.file.name)}</span><span class="size">${fmtSize(st.file.size)}</span><button type="button" id="chipX" aria-label="Remove attachment">✕</button>` : '';
    $('chipX')?.addEventListener('click', () => { st.file = null; paintChip(); });
  }

  // Tell the other person we're typing (at most once every 2.5 s, and only in a real conversation).
  let lastTypingSent = 0;
  function signalTyping() {
    if (!st.active?.conversationId || Date.now() - lastTypingSent < 2500) return;
    lastTypingSent = Date.now();
    api('/messages/typing', { method: 'POST', token: token(), body: { conversationId: st.active.conversationId } }).catch(() => {});
  }
  let typingTimer;
  function showTyping(name) {
    const hint = $('chatHint'); if (!hint) return;
    hint.innerHTML = `<span class="typing"><i></i><i></i><i></i></span> ${esc(name.split(' ')[0])} is typing…`;
    clearTimeout(typingTimer); typingTimer = setTimeout(hideTyping, 4000);
  }
  function hideTyping() { clearTimeout(typingTimer); const hint = $('chatHint'); if (hint) hint.textContent = 'Enter to send · Shift+Enter for a new line'; }

  function attachmentHTML(m) {
    const a = m.attachment, image = a.type?.startsWith('image/');
    return image
      ? `<button class="att-img" data-att="${m.id}" data-name="${esc(a.name)}" type="button" title="${esc(a.name)}"><img alt="${esc(a.name)}" data-thumb="${m.id}"></button>`
      : `<button class="att-file" data-att="${m.id}" data-name="${esc(a.name)}" type="button">${icon('file', 20)}<span><b>${esc(a.name)}</b><small>${fmtSize(a.size)} · ${a.type === 'application/pdf' ? 'Tap to view' : 'Tap to download'}</small></span></button>`;
  }
  function wireAttachments(box) {
    box.querySelectorAll('[data-att]').forEach((b) => b.addEventListener('click', () => viewFile(`/messages/files/${b.dataset.att}`, b.dataset.name)));
    box.querySelectorAll('[data-thumb]').forEach(async (img) => {
      const id = img.dataset.thumb;
      try {
        if (!thumbs.has(id)) thumbs.set(id, URL.createObjectURL(await fetchBlob(`/messages/files/${id}`)));
        img.src = thumbs.get(id);
      } catch { img.replaceWith(Object.assign(document.createElement('span'), { textContent: 'Image unavailable', className: 'row-sub' })); }
    });
  }

  function autosize() { const i = $('chatInput'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 120) + 'px'; }
  function updateCount() {
    const n = $('chatInput').value.length;
    $('chatCount').innerHTML = n > MAX_LEN - 200 ? `<span class="${n > MAX_LEN ? 'over' : ''}">${n}/${MAX_LEN}</span>` : '';
  }

  function interviewCard(m) {
    const iv = m.meta || {};
    const link = safeLink(iv.link);
    return `<div class="iv-card">
      <div class="iv-card__head">${icon('calendar', 14)} INTERVIEW SCHEDULED</div>
      <h4>${esc(iv.title || 'Interview')}</h4>
      <dl>
        <dt>When</dt><dd>${esc(fmtDateTime(iv.scheduledAt))}</dd>
        <dt>Format</dt><dd>${esc(iv.mode || '—')}</dd>
        ${iv.interviewer ? `<dt>Interviewer</dt><dd>${esc(iv.interviewer)}</dd>` : ''}
      </dl>
      ${link ? `<a class="btn btn-primary btn-sm" href="${esc(link)}" target="_blank" rel="noopener">${icon('video', 14)} Join call</a>` : ''}
    </div>`;
  }

  function renderMessages(forceBottom) {
    const box = paneEl.querySelector('#chatScroll');
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (!st.messages.length) {
      const a = st.active;
      box.innerHTML = `<div class="chat-empty"><div class="stat-icon tone-violet">${icon('chat', 18)}</div>
        <b>Start the conversation</b>Say hello to ${esc(a.other.name)}${a.other.positions ? ` about ${esc(a.other.positions)}` : ''}.</div>`;
      return;
    }
    const lastMine = [...st.messages].reverse().find((m) => m.senderType === meType && !m.pending && !m.failed);
    let prevDay = '', prevSender = '', html = '';
    st.messages.forEach((m) => {
      const day = new Date(m.createdAt).toDateString();
      if (day !== prevDay) { html += `<div class="day-sep">${dayLabel(m.createdAt)}</div>`; prevDay = day; prevSender = ''; }
      if (m.kind === 'system') { html += `<div class="sys-note">${linkify(m.body)}</div>`; prevSender = ''; return; }
      const mine = m.senderType === meType;
      const showSeen = mine && lastMine && m.id === lastMine.id && m.id <= st.otherReadUpTo;
      const time = new Date(m.createdAt).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
      html += `<div class="msg ${mine ? 'me' : ''} ${m.pending ? 'pending' : ''} ${prevSender && prevSender !== m.senderType ? 'gap-top' : ''}">
        ${m.kind === 'interview' ? interviewCard(m) : m.attachment
          ? `<div class="bubble has-att">${attachmentHTML(m)}${m.body ? `<div class="att-caption">${linkify(m.body)}</div>` : ''}</div>`
          : `<div class="bubble">${linkify(m.body)}</div>`}
        <div class="msg__meta">${m.pending ? 'Sending…' : time}${showSeen ? ' · Seen' : ''}</div></div>`;
      prevSender = m.senderType;
    });
    box.innerHTML = html;
    wireAttachments(box);
    if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
  }

  async function openConversation(conversationId, other, { focus = true } = {}) {
    st.active = { conversationId, other };
    st.messages = []; st.otherReadUpTo = 0;
    window.__iternActiveChat = conversationId;
    shell.classList.add('thread-open');
    renderPane(); renderList();
    if (conversationId) await loadThread({ initial: true });
    if (focus && window.innerWidth > 900) $('chatInput')?.focus();
  }

  // Loads (new) messages. The server marks the other person's messages as read as a side effect.
  async function loadThread({ initial = false } = {}) {
    const a = st.active;
    if (!a?.conversationId) return;
    const lastId = initial ? 0 : Math.max(0, ...st.messages.filter((m) => !m.pending).map((m) => m.id));
    const data = await api(`/messages/conversations/${a.conversationId}/messages${lastId ? `?after=${lastId}` : ''}`, { token: token() });
    if (st.active !== a) return; // user switched conversation while this was loading
    const known = new Set(st.messages.map((m) => m.id));
    const fresh = data.messages.filter((m) => !known.has(m.id));
    st.otherReadUpTo = data.otherReadUpTo;
    if (initial) st.messages = data.messages; else if (fresh.length) st.messages.push(...fresh);
    renderMessages(initial || fresh.some((m) => m.senderType !== meType));
    if (fresh.length || initial) refreshList().catch(() => {});
  }

  /* ---------------- sending ---------------- */
  async function send() {
    const a = st.active, input = $('chatInput');
    const body = input.value.trim(), file = st.file;
    if (!a || (!body && !file) || st.sending) return;
    if (body.length > MAX_LEN) { toast(`Messages can be at most ${MAX_LEN} characters.`); return; }
    st.sending = true; hideTyping();
    const tmpId = `tmp-${++st.tmp}`;
    st.messages.push({ id: tmpId, senderType: meType, body: file ? (body || `📎 ${file.name}`) : body, kind: 'text', createdAt: new Date().toISOString(), pending: true });
    input.value = ''; st.file = null; autosize(); updateCount(); paintChip();
    renderMessages(true);
    try {
      let res;
      if (file) {
        const form = new FormData();
        form.append('file', file); form.append('body', body);
        if (a.conversationId) form.append('conversationId', a.conversationId); else form.append('toId', a.other.id);
        const r = await fetch(`${API_BASE}/messages/file`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: form });
        res = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(res.error || 'Could not send the file.');
      } else {
        res = await api('/messages', { method: 'POST', token: token(),
          body: a.conversationId ? { conversationId: a.conversationId, body } : { toId: a.other.id, body } });
      }
      a.conversationId = res.conversationId;
      window.__iternActiveChat = res.conversationId;
      st.messages = st.messages.filter((m) => m.id !== tmpId);
      if (!st.messages.some((m) => m.id === res.message.id)) st.messages.push(res.message);
      renderMessages(true);
      await refreshList();
    } catch (err) {
      st.messages = st.messages.filter((m) => m.id !== tmpId);
      input.value = body; st.file = file; autosize(); paintChip(); renderMessages(true);
      toast(err.message || 'Could not send your message.');
    } finally { st.sending = false; input.focus(); }
  }

  /* ---------------- "New message" picker ---------------- */
  async function openContacts() {
    $('contactsModal').innerHTML = `<h3>New message</h3>
      <p class="help-text" style="margin:4px 0 12px;">${portal === 'company' ? 'Students who applied to your postings.' : 'Companies you have applied to.'}</p>
      <input class="input" id="contactSearch" placeholder="Search…" autocomplete="off" style="margin-bottom:8px;">
      <div id="contactList"><div class="empty-state">Loading…</div></div>
      <button class="btn btn-ghost btn-block" id="contactClose" type="button" style="margin-top:12px;">Close</button>`;
    $('contactsBackdrop').classList.add('open');
    const close = () => $('contactsBackdrop').classList.remove('open');
    $('contactClose').addEventListener('click', close);
    $('contactsBackdrop').onclick = (e) => { if (e.target.id === 'contactsBackdrop') close(); };

    st.contacts = await api('/messages/contacts', { token: token() });
    const draw = () => {
      const q = $('contactSearch').value.trim().toLowerCase();
      const rows = st.contacts.filter((c) => !q || c.name.toLowerCase().includes(q));
      $('contactList').innerHTML = rows.map((c) => `
        <div class="contact-row" data-id="${c.id}">${avatar(c)}
          <div style="flex:1;min-width:0;"><div class="row-title">${esc(c.name)}</div>
          <div class="row-sub">${esc(c.positions || c.subtitle)}</div></div>
          <span class="pill ${c.conversationId ? 'pill-violet' : 'pill-blue'}">${c.conversationId ? 'Open chat' : 'Message'}</span>
        </div>`).join('') || `<div class="empty-state">${st.contacts.length ? 'No matches.' : (portal === 'company'
          ? 'No applicants yet.' : 'Apply to an internship first — then you can message the company.')}</div>`;
      $('contactList').querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
        const c = st.contacts.find((x) => x.id === el.dataset.id);
        close(); startWith(c);
      }));
    };
    $('contactSearch').addEventListener('input', draw);
    draw();
  }

  function startWith(contact) {
    const existing = st.conversations.find((c) => c.other.id === contact.id) || (contact.conversationId && { id: contact.conversationId });
    openConversation(existing ? existing.id : null, { ...contact });
  }

  /* ---------------- wiring ---------------- */
  $('newMsgBtn').addEventListener('click', () => openContacts().catch((e) => toast(e.message)));
  $('chatSearch').addEventListener('input', renderList);

  // Realtime: the server pushes message:new / message:read through the shared event stream.
  window.addEventListener('itern:live', (e) => {
    const { name, data } = e.detail;
    if (name === 'message:typing' && data.conversationId === st.active?.conversationId) showTyping(data.name || 'They');
    if (name === 'message:new' && data.conversationId === st.active?.conversationId) hideTyping();
    if (name === 'message:new' || name === 'message:read' || name === 'resync') {
      refreshList().catch(() => {});
      if (st.active?.conversationId && (name === 'resync' || data.conversationId === st.active.conversationId)) loadThread().catch(() => {});
    }
  });
  // Safety net if the live stream is down: poll gently while the tab is visible.
  setInterval(() => {
    if (document.hidden) return;
    refreshList().catch(() => {});
    if (st.active?.conversationId) loadThread().catch(() => {});
  }, 20000);

  /* ---------------- start ---------------- */
  (async function init() {
    renderPane();
    await refreshList();
    const params = new URLSearchParams(location.search);
    const withId = params.get('with');
    if (!withId) return;
    const existing = st.conversations.find((c) => c.other.id === withId);
    if (existing) return openConversation(existing.id, existing.other);
    st.contacts = await api('/messages/contacts', { token: token() });
    const contact = st.contacts.find((c) => c.id === withId);
    if (contact) startWith(contact);
    else toast(portal === 'company'
      ? 'You can message a student once they have applied to one of your postings.'
      : 'You can message a company once you have applied to one of its postings.');
  })().catch((err) => toast(err.message || 'Could not load messages.'));
}
