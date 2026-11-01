// Renders one printed duty-day page (letter landscape). Layout follows design-reference.html.

import { addDays, longDate, militaryDate, WEEKDAYS, weekday } from './dates';
import { BLOCKS, POSITIONS, type Cell, type DayBill, type Profile } from './model';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function reportTime(block: number): string {
  const start = [6, 12, 18, 24][block];
  const h = (start - 1 + 24) % 24;
  return `${String(h).padStart(2, '0')}30`;
}

/** Shrink long names until they fit their cell, so nothing is cut off. Needs the sheet laid out. */
export function fitNames(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>('.sheet .nm, .sheet .cellname')) {
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    // At most two lines; table cells stretch to fit content, so measure lines, not the cell.
    const tooTall = () => el.scrollHeight > size * 1.05 * 2 + 2;
    while ((el.scrollWidth > el.clientWidth + 0.5 || tooTall()) && size > 9) {
      size -= 0.5;
      el.style.fontSize = `${size}px`;
    }
  }
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
  const nameCell = (cell: Cell, ref: string, extraClass = '') => {
    const p = person(cell);
    const tags = (cell.double ? '<span class="tag">DOUBLE</span>' : '') + (cell.forced ? '<span class="tag warn">!</span>' : '');
    const attr = opts.interactive ? ` data-cell="${bill.date}|${ref}" role="button" tabindex="0"` : '';
    const title = cell.forced ? ` title="${esc(cell.forced)}"` : '';
    return `<td class="name ${extraClass}"${attr}${title}><span class="nm">${esc(p?.name ?? '')}</span>${tags}</td>
      <td class="room">${esc(p?.room ?? '')}</td><td class="int"></td>`;
  };
  const superBand = (label: string, uniform: string, cell: Cell, ref: string) => {
    const p = person(cell);
    const attr = opts.interactive ? ` data-cell="${bill.date}|${ref}" role="button" tabindex="0"` : '';
    return `<div><div class="role">${label}<small>${uniform} · all day</small></div>
      <div class="cellname"${attr}>${esc(p?.name ?? '')}${cell.forced ? '<span class="tag warn">!</span>' : ''}</div>
      <div class="cellbox"><div class="lbl">Room</div><b>${esc(p?.room ?? '')}</b></div>
      <div class="cellbox"><div class="lbl">Int</div></div></div>`;
  };
  const next = addDays(bill.date, 1);
  const rows = BLOCKS.map((label, b) => {
    const sub = b === 3 ? `${WEEKDAYS[weekday(next)]} ${militaryDate(next).slice(0, 6)} · rpt ${reportTime(b)}` : `report ${reportTime(b)}`;
    return `<tr><td class="time"><b>${label.replace('-', '–')}</b><span>${sub}</span></td>
      ${POSITIONS.map((pos) => nameCell(bill.blocks[b][pos], `${b}|${pos}`, 'gstart')).join('')}</tr>`;
  }).join('');
  const contactRow = (c: { label: string; phone: string }, fallback: string) =>
    `<div class="row"><span class="k">${esc(c.label || fallback)}</span><span class="v">${esc(c.phone)}</span></div>`;
  const leadRow = (title: string, c: { label: string; phone: string }) =>
    `<div class="row"><span><span class="k">${title}</span><br><span class="who">${esc(c.label)}</span></span><span class="v">${esc(c.phone)}</span></div>`;
  const notes = s.notes
    .split('\n')
    .map((l) => l.replace(/^\s*[•\-*\d.)]+\s*/, '').trim())
    .filter(Boolean);
  const rev = opts.revision > 0 ? ` · <b>REV ${opts.revision}</b>${opts.revisionReason ? ` (${esc(opts.revisionReason)})` : ''}` : '';

  return `<div class="sheet">
  <div class="head">
    <div><div class="lbl">Duty Section</div><div class="big">${esc(s.section)}</div></div>
    <div class="title">602 WATCHBILL</div>
    <div class="right"><div class="lbl">Duty Day</div><div class="big">${longDate(bill.date)}</div>
      <div class="sub">0600 ${WEEKDAYS[weekday(bill.date)]} → 0600 ${WEEKDAYS[weekday(next)]} ${militaryDate(next).slice(0, 6)}${rev}</div></div>
  </div>
  <div class="supers">
    ${superBand('SUPER (MOOW)', 'NSU', bill.superMoow, '-1|superMoow')}
    ${superBand('SUPER (ROVER)', 'NWU', bill.superRover, '-1|superRover')}
  </div>
  <table class="grid">
    <colgroup><col class="c-time">${'<col><col class="c-room"><col class="c-int">'.repeat(3)}</colgroup>
    <thead>
      <tr><th rowspan="2">WATCH<br><small>(report 30 min prior)</small></th>
        <th colspan="3" class="gstart">MOOW <small>· NSU</small></th>
        <th colspan="3" class="gstart">ROVER 1 <small>· NWU</small></th>
        <th colspan="3" class="gstart">ROVER 2 <small>· NWU</small></th></tr>
      <tr>${'<th class="gstart">NAME</th><th>ROOM</th><th>INT</th>'.repeat(3)}</tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="lower">
    <div class="box"><h3>FOR EMERGENCIES</h3>${s.emergencies.map((c, i) => contactRow(c, `Contact ${i + 1}`)).join('')}</div>
    <div class="box"><h3>CHAIN OF COMMAND</h3>
      ${leadRow('Duty section lead', s.sectionLead)}
      ${s.deckLeads.map((c) => leadRow('Deck lead', c)).join('')}
      <div class="row small">Watchbill issues go to your deck leads first.</div></div>
    <div class="box"><h3>STANDING ORDERS</h3><ol class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol></div>
  </div>
  ${s.banner.trim() ? `<div class="banner">${esc(s.banner)}</div>` : ''}
  <div class="foot"><span>Coordinator: ${esc(s.coordinator) || '__________'}</span><span>INT = initial when you sign for your watch</span></div>
</div>`;
}
