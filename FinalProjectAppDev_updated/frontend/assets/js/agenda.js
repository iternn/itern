// "Upcoming interviews" list shown on both dashboards.
import { api, Session } from './api.js';
import { esc, icon, safeLink, toast } from './nav.js';
import { downloadIcs } from './calendar.js';

const dayLabel = (d) => {
  const dt = new Date(d), now = new Date(), tom = new Date(); tom.setDate(now.getDate() + 1);
  if (dt.toDateString() === now.toDateString()) return 'Today';
  if (dt.toDateString() === tom.toDateString()) return 'Tomorrow';
  return dt.toLocaleDateString('en-PH', { weekday: 'long' });
};

export async function mountAgenda(el, portal) {
  let items = [];
  try { items = await api('/interviews/upcoming', { token: Session.token() }); }
  catch { el.innerHTML = '<div class="empty-state">Couldn\'t load interviews right now.</div>'; return; }

  if (!items.length) {
    el.innerHTML = `<div class="empty-state">${portal === 'company'
      ? 'No interviews scheduled. Schedule one from the Applicants page.'
      : 'No interviews scheduled yet. Companies will set a time once they review your application.'}</div>`;
    return;
  }
  const eventFor = (it) => ({
    uid: it.id, title: `Interview: ${it.title} — ${portal === 'company' ? it.intern_name : it.company_name}`,
    start: it.scheduled_at, durationMin: 60,
    description: [`Position: ${it.title}`, it.interviewer ? `Interviewer: ${it.interviewer}` : '', it.meeting_link ? `Join: ${it.meeting_link}` : ''].filter(Boolean).join('\n'),
    location: it.mode === 'Video call' ? 'Video call' : 'On-site', url: safeLink(it.meeting_link) || undefined,
  });

  el.innerHTML = items.map((it, i) => {
    const d = new Date(it.scheduled_at), link = safeLink(it.meeting_link);
    const who = portal === 'company' ? it.intern_name : it.company_name;
    return `<div class="agenda-item">
      <div class="agenda-date"><small>${d.toLocaleDateString('en-PH', { month: 'short' }).toUpperCase()}</small>${d.getDate()}</div>
      <div style="flex:1;min-width:0;">
        <div class="row-title">${esc(it.title)} · ${esc(who)}</div>
        <div class="row-sub">${dayLabel(it.scheduled_at)}, ${d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })} · ${esc(it.mode || '')}${it.interviewer ? ` · with ${esc(it.interviewer)}` : ''}</div>
      </div>
      <div class="row-meta">
        ${link ? `<a class="btn btn-primary btn-sm" href="${esc(link)}" target="_blank" rel="noopener">${icon('video', 13)} Join</a>` : ''}
        <button class="btn btn-ghost btn-sm" data-ics="${i}" type="button">${icon('calendar', 13)} Add to calendar</button>
      </div></div>`;
  }).join('') + (items.length > 1 ? '<div style="text-align:right;margin-top:10px;"><button class="btn btn-ghost btn-sm" id="icsAll" type="button">Add all to calendar</button></div>' : '');

  el.querySelectorAll('[data-ics]').forEach((b) => b.addEventListener('click', () => {
    downloadIcs('itern-interview.ics', [eventFor(items[Number(b.dataset.ics)])]);
    toast('Calendar file downloaded — open it to add the interview.');
  }));
  el.querySelector('#icsAll')?.addEventListener('click', () => { downloadIcs('itern-interviews.ics', items.map(eventFor)); toast('Calendar file downloaded.'); });
}
