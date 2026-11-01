// Renders one printed duty-day page (letter landscape): time blocks down the left,
// supervision, contacts and standing orders in a narrow column on the right.

import { addDays, longDate, militaryDate, WEEKDAYS, weekday } from './dates';
import { BANNER, EMERGENCY, STANDING_ORDERS } from './fixed';
import { BLOCKS, POSITIONS, POS_LABEL, type Cell, type DayBill, type Profile } from './model';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Shrink long names until they fit their slot (two lines at most), so nothing is cut off. */
export function fitNames(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>('.sheet .nm')) {
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    const tooTall = () => el.scrollHeight > size * 1.1 * 2 + 2;
    while ((el.scrollWidth > el.clientWidth + 0.5 || tooTall()) && size > 8) {
      size -= 0.5;
      el.style.fontSize = `${size}px`;
    }
  }
}

// Small line icons for the four watches: sunrise, sun, moon, moon and stars.
const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = [
  `<svg viewBox="0 0 24 24" ${S}><path d="M4 18h16M7 18a5 5 0 0 1 10 0M12 6v3M5.6 10.6l1.8 1.4M18.4 10.6l-1.8 1.4"/></svg>`,
  `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>`,
  `<svg viewBox="0 0 24 24" ${S}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`,
  `<svg viewBox="0 0 24 24" ${S}><path d="M17 15.5A7 7 0 0 1 8.5 7a7 7 0 1 0 8.5 8.5z"/><path d="M17 3.5l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7zM20.5 9.5l.4.9.9.4-.9.4-.4.9-.4-.9-.9-.4.9-.4z"/></svg>`,
];

function reportTime(block: number): string {
  return ['0530', '1130', '1730', '2330'][block];
}

export interface BillOptions {
  revision: number;
  revisionReason?: string;
  /** Adds data-cell attributes so names can be tapped to swap. */
  interactive?: boolean;
}

export function renderBill(bill: DayBill, profile: Profile, opts: BillOptions): string {
  const s = profile.settings;
  const person = (cell: Cell) => profile.people.find((p) => p.id === cell.personId);
  const tap = (ref: string) => (opts.interactive ? ` data-cell="${bill.date}|${ref}" role="button" tabindex="0"` : '');
  const tags = (cell: Cell) =>
    (cell.double ? '<span class="tag">DOUBLE</span>' : '') + (cell.forced ? `<span class="tag warn" title="${esc(cell.forced)}">!</span>` : '');
  const next = addDays(bill.date, 1);

  const blocks = BLOCKS.map((label, b) => {
    const [from, to] = label.split('-');
    const when = b === 3 ? `ends ${WEEKDAYS[weekday(next)]} ${militaryDate(next).slice(0, 6)}` : '';
    const rows = POSITIONS.map((pos) => {
      const cell = bill.blocks[b][pos];
      const p = person(cell);
      return `<div class="slot">
        <div class="role">${POS_LABEL[pos]}<small>${pos === 'moow' ? 'NSU' : 'NWU'}</small></div>
        <div class="field name"${tap(`${b}|${pos}`)}><span class="nm">${esc(p?.name ?? '')}</span>${tags(cell)}</div>
        <div class="field room"><span class="k">Room</span>${esc(p?.room ?? '')}</div>
        <div class="field int"><span class="k">Initials</span></div>
      </div>`;
    }).join('');
    return `<section class="block">
      <div class="time"><span class="dot"></span><i class="ic">${ICONS[b]}</i><b>${from}–<br>${to}</b><small>Report ${reportTime(b)}${when ? `<br>${when}` : ''}</small></div>
      <div class="slots">${rows}</div>
    </section>`;
  }).join('');

  const superRow = (label: string, uniform: string, cell: Cell, ref: string) => {
    const p = person(cell);
    return `<div class="sup"><div class="k">${label} <small>${uniform}</small></div>
      <div class="sname"${tap(ref)}><span class="nm">${esc(p?.name ?? '')}</span>${tags(cell)}</div>
      <div class="smeta"><span>Room <b>${esc(p?.room ?? '')}</b></span><span>Initials</span></div></div>`;
  };
  const line = (k: string, v: string, phone = '') =>
    `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span>${phone ? `<span class="ph">${esc(phone)}</span>` : ''}</div>`;
  const rev = opts.revision > 0 ? `<span class="rev">REV ${opts.revision}${opts.revisionReason ? ` · ${esc(opts.revisionReason)}` : ''}</span>` : '';

  return `<div class="sheet">
  <header class="bh">
    <div class="bt">602 WATCHBILL</div>
    <div class="bf"><span class="k">Duty Section</span><b>${esc(s.section) || '&nbsp;'}</b></div>
    <div class="bf"><span class="k">Date</span><b>${longDate(bill.date)}</b>${rev}</div>
    <div class="bf early">» Report 30 minutes early</div>
  </header>
  <div class="body">
    <main class="blocks">${blocks}</main>
    <aside class="side">
      <section><h4>SUPERS</h4>
        ${superRow('Super (MOOW)', 'NSU', bill.superMoow, '-1|superMoow')}
        ${superRow('Super (Rover)', 'NWU', bill.superRover, '-1|superRover')}
      </section>
      <section><h4>CHAIN OF COMMAND</h4>
        ${line('Section lead', s.sectionLead.label, s.sectionLead.phone)}
        ${s.deckLeads.filter((d) => d.label || d.phone).map((d) => line('Deck lead', d.label, d.phone)).join('')}
        ${s.coordinator ? line('Coordinator', s.coordinator) : ''}
        <p class="fine">Direct all watchbill issues to your deck leads.</p>
      </section>
      <section><h4>EMERGENCY CONTACTS</h4>
        ${EMERGENCY.map((e) => `<div class="kv"><span class="k">${esc(e.label)}</span><span class="ph">${e.phone}</span></div>`).join('')}
      </section>
      <section class="orders"><h4>STANDING ORDERS</h4>
        <ol>${STANDING_ORDERS.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>
      </section>
    </aside>
  </div>
  <footer class="bb">${esc(BANNER)}</footer>
</div>`;
}
