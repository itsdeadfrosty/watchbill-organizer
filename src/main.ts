import './style.css';
import { esc, fitNames, renderBill } from './bill';
import { deriveKeys, generateCode, isValidCode, type Keys } from './crypto';
import { addDays, dateRange, longDate, militaryDate, today, WEEKDAYS } from './dates';
import { BLOCKS, emptyProfile, migrate, newId, newPerson, POS_LABEL, type Bills, type Cell, type DayBill, type Person, type Pos } from './model';
import { counts, replacements, solve, type Role } from './scheduler';
import { askPersistent, DeviceStore, makeBackup, readBackup, save, unlock, type BackupFile } from './storage';

type Tab = 'roster' | 'prefs' | 'bill' | 'changes' | 'history' | 'settings';
const TABS: [Tab, string][] = [
  ['roster', 'Roster'],
  ['prefs', 'Preferences'],
  ['bill', 'Build'],
  ['changes', 'Changes'],
  ['history', 'History'],
  ['settings', 'Settings'],
];
const BLOCK_NAMES = ['Morning', 'Afternoon', 'Evening', 'Night'];

const store = new DeviceStore();
const app = document.querySelector<HTMLDivElement>('#app')!;
const printArea = document.querySelector<HTMLDivElement>('#print-area')!;

const ui = {
  session: null as null | { code: string; keys: Keys },
  profile: emptyProfile(),
  tab: 'roster' as Tab,
  start: today(),
  end: addDays(today(), 6),
  warnings: [] as string[],
  person: null as string | null,
  editing: null as string | null,
  changesMode: 'appt' as 'appt' | 'double' | 'swap',
  swapDate: '',
  apptBlocks: [] as number[],
  newCode: null as string | null,
  busy: '',
  saved: '',
  message: '',
};

// ---------- saving ----------

let saveTimer: number | undefined;
function changed() {
  if (!ui.session) return;
  ui.saved = 'Saving…';
  setStatus();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      await save(store, ui.session!.keys, ui.profile);
      ui.saved = 'Saved';
    } catch (e) {
      ui.saved = `Save failed: ${(e as Error).message}`;
    }
    setStatus();
  }, 500);
}

function setStatus() {
  const el = document.querySelector('#status');
  if (el) el.textContent = ui.saved;
}

// ---------- scheduling helpers ----------

const active = () => ui.profile.people.filter((p) => p.active);
const plannedDates = () => Object.keys(ui.profile.bills).sort();

function name(id: string | null | undefined): string {
  return ui.profile.people.find((p) => p.id === id)?.name ?? '(nobody)';
}

function sameBill(a?: DayBill, b?: DayBill) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function commit(newBills: Bills, reason: string, warnings: string[] = []) {
  const p = ui.profile;
  const changedDates = Object.keys(newBills)
    .sort()
    .filter((d) => !sameBill(p.bills[d], newBills[d]));
  p.bills = { ...p.bills, ...newBills };
  if (changedDates.length) {
    p.history.push({
      id: newId(),
      at: new Date().toISOString(),
      reason,
      dates: changedDates,
      bills: Object.fromEntries(changedDates.map((d) => [d, structuredClone(newBills[d])])),
      changedAfterPrint: changedDates.filter((d) => p.printed[d]),
    });
  }
  ui.warnings = warnings;
  ui.message = changedDates.length ? `${reason}: ${changedDates.length} day(s) updated.` : `${reason}: nothing needed to change.`;
  changed();
}

function runSolve(dates: string[], reason: string) {
  const p = ui.profile;
  if (!dates.length) {
    ui.message = `${reason}. No bills from that date on, so nothing changed.`;
    return changed();
  }
  const res = solve({ dates, people: p.people, appointments: p.appointments, doubles: p.doubles, bills: p.bills, seed: p.seed });
  commit(res.bills, reason, res.warnings);
}

/** Re-solve every built day from `date` forward; earlier days stay fixed. */
function resolveFrom(date: string, reason: string) {
  runSolve(plannedDates().filter((d) => d >= date), reason);
}

function revisionsOf(date: string) {
  return ui.profile.history.filter((h) => h.dates.includes(date));
}

function revisionOf(date: string): { n: number; reason?: string } {
  const revs = revisionsOf(date);
  return { n: Math.max(0, revs.length - 1), reason: revs.length > 1 ? revs[revs.length - 1].reason.split(':')[0] : undefined };
}

// ---------- rendering ----------

/** Stop browsers and password managers from filling saved names, phones or addresses into our boxes. */
function hardenInputs() {
  let n = 0;
  for (const el of app.querySelectorAll<HTMLElement>('input:not([type=password]):not([type=file]):not([type=checkbox]):not([hidden]), textarea')) {
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('data-1p-ignore', '');
    el.setAttribute('data-lpignore', 'true');
    el.setAttribute('data-bwignore', 'true');
    el.setAttribute('name', `wo-field-${n++}`);
  }
}

function render() {
  if (!ui.session) return renderLogin();
  const built = plannedDates().length > 0;
  const views: Record<Tab, () => string> = { roster: rosterTab, prefs: prefsTab, bill: billTab, changes: changesTab, history: historyTab, settings: settingsTab };
  app.innerHTML = `
  <header class="top">
    <div class="brand">602 Watchbill</div>
    <div id="status" class="status">${esc(ui.saved)}</div>
    <button class="sm primary" data-act="generate" ${active().length ? '' : 'disabled'}>Build</button>
  </header>
  <nav class="tabs">${TABS.map(([t, l]) => {
    const off = t === 'changes' && !built;
    return `<button class="${ui.tab === t ? 'on' : ''}" data-tab="${t}" ${off ? 'disabled title="Build a bill first"' : ''}>${l}</button>`;
  }).join('')}</nav>
  ${ui.message ? `<div class="message"><span>${esc(ui.message)}</span><button class="link" data-act="dismiss">×</button></div>` : ''}
  <main class="view">${views[ui.tab]()}</main>`;
  hardenInputs();
  fitSheets();
}

function renderLogin() {
  if (ui.newCode) {
    app.innerHTML = `<div class="login card">
      <h1>Your save code</h1>
      <p class="code">${ui.newCode}</p>
      <p>Write it down or save it in your password manager. It is the only way to open your data and it can't be recovered.</p>
      <label class="check"><input type="checkbox" id="wrote"> I saved it</label>
      <button class="primary wide" data-act="start-new" disabled id="go">Continue</button>
    </div>`;
    document.querySelector('#wrote')!.addEventListener('change', (e) => {
      (document.querySelector('#go') as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked;
    });
    return;
  }
  app.innerHTML = `<div class="login card">
    <h1>602 Watchbill</h1>
    <p class="muted">Saved encrypted on this device only.</p>
    <form id="login">
      <input type="text" name="username" autocomplete="username" value="watchbill" hidden>
      <label>Save code<input id="code" name="password" type="password" autocomplete="current-password" autocapitalize="characters" spellcheck="false" placeholder="ABC-123"></label>
      <button class="primary wide" ${ui.busy ? 'disabled' : ''}>${ui.busy || 'Open'}</button>
    </form>
    ${ui.message ? `<p class="error">${esc(ui.message)}</p>` : ''}
    <div class="login-links">
      <button class="ghost" data-act="create">Create new profile</button>
      <details><summary>Restore from a backup file</summary>
        <label>Backup file<input type="file" id="restore-file" accept=".json,application/json"></label>
        <label>Save code for that backup<input id="restore-code" autocomplete="off" spellcheck="false"></label>
        <button data-act="restore-login">Restore</button>
      </details>
    </div>
  </div>`;
  hardenInputs();
  document.querySelector('#login')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = (document.querySelector('#code') as HTMLInputElement).value;
    if (!isValidCode(code)) {
      ui.message = 'That is not a valid save code (6 letters and numbers, like ABC-123).';
      return render();
    }
    ui.busy = 'Unlocking…';
    ui.message = '';
    render();
    const res = await unlock(store, code);
    ui.busy = '';
    if (!res) {
      ui.message = 'No profile on this device matches that code.';
      return render();
    }
    ui.session = { code, keys: res.keys };
    ui.profile = migrate(res.profile);
    ui.tab = plannedDates().length ? 'bill' : 'roster';
    ui.saved = '';
    askPersistent();
    render();
  });
}

function sheet(date: string, bills: Bills, interactive: boolean, revisionOverride?: string) {
  const r = revisionOverride ? { n: 0, reason: revisionOverride } : revisionOf(date);
  return `<div class="sheet-wrap">${renderBill(bills[date], ui.profile, { revision: r.n, revisionReason: r.reason, interactive })}</div>`;
}

// Roster

function rosterTab(): string {
  const people = active();
  const former = ui.profile.people.filter((p) => !p.active);
  const row = (x: Person) =>
    ui.editing === x.id
      ? `<li class="editing"><input id="e-name" value="${esc(x.name)}" aria-label="Name"><input id="e-room" class="room-in" value="${esc(x.room)}" aria-label="Room">
         <button class="sm primary" data-act="save-person">Save</button><button class="sm ghost danger" data-act="remove-person">Remove</button></li>`
      : `<li><span class="pn">${esc(x.name)}</span><span class="pr">${esc(x.room)}</span><button class="sm ghost" data-edit="${x.id}">Edit</button></li>`;
  return `<section class="card">
    <div class="head"><h2>Roster</h2><span class="muted">${people.length} ${people.length === 1 ? 'person' : 'people'}</span></div>
    <form id="add-person" class="addrow">
      <input id="n" placeholder="Name (e.g. DOE, J.)" autocomplete="off" aria-label="Name">
      <input id="r" class="room-in" placeholder="Room" autocomplete="off" aria-label="Room">
      <button class="primary add" aria-label="Add">+</button>
    </form>
    ${people.length ? `<ul class="people">${people.map(row).join('')}</ul>` : '<p class="muted">Add everyone in the duty section. At least 9 people are needed for everyone to get 12 hours of rest.</p>'}
    ${former.length ? `<details class="former"><summary>${former.length} removed (kept for history)</summary><ul class="people">${former
      .map((x) => `<li><span class="pn">${esc(x.name)}</span><span class="pr">${esc(x.room)}</span><button class="sm ghost" data-restore="${x.id}">Restore</button></li>`)
      .join('')}</ul></details>` : ''}
  </section>`;
}

// Preferences

function prefSummary(p: Person): string {
  const parts: string[] = [];
  if (p.pref.blocks.length) parts.push(p.pref.blocks.map((b) => BLOCK_NAMES[b]).join(', '));
  if (p.pref.pos) parts.push(p.pref.pos === 'moow' ? 'MOOW' : 'Rover');
  if (p.pref.days.length) parts.push(p.pref.days.map((d) => WEEKDAYS[d].slice(0, 2)).join(' '));
  return parts.join(' · ');
}

function toggles(group: string, items: string[], on: (i: number) => boolean, sub?: string[]) {
  return `<div class="toggles">${items
    .map((l, i) => `<button class="${on(i) ? 'on' : ''}" data-toggle="${group}" data-i="${i}" aria-pressed="${on(i)}">${l}${sub ? `<small>${sub[i]}</small>` : ''}</button>`)
    .join('')}</div>`;
}

function prefsTab(): string {
  const people = active();
  const sel = people.find((x) => x.id === ui.person);
  if (!people.length) return '<section class="card"><p class="muted">Add people on the Roster tab first.</p></section>';
  return `<div class="split">
    <section class="card names">
      <ul class="pick">${people
        .map((x) => `<li><button class="${x.id === ui.person ? 'on' : ''}" data-person="${x.id}"><span>${esc(x.name)}</span><small>${esc(prefSummary(x)) || 'No preference'}</small></button></li>`)
        .join('')}</ul>
    </section>
    <section class="card">${
      sel
        ? `<div class="head"><h2>${esc(sel.name)}</h2><button class="sm ghost" data-act="clear-prefs">Clear</button></div>
      <h3>Watch</h3>${toggles('blocks', BLOCK_NAMES, (i) => sel.pref.blocks.includes(i), [...BLOCKS])}
      <h3>Position</h3>${toggles('pos', ['MOOW', 'Rover', 'Either'], (i) => sel.pref.pos === (['moow', 'rover', null] as const)[i])}
      <h3>Days</h3>${toggles('days', WEEKDAYS.map((d) => d[0] + d.slice(1).toLowerCase()), (i) => sel.pref.days.includes(i))}
      <p class="muted small">Saved as you tap. Used the next time you build. Watch counts most, then position, then days. Nothing is guaranteed: every watch still has to be filled.</p>`
        : '<p class="muted">Pick a name to set what they prefer.</p>'
    }</section></div>`;
}

// Build

function billTab(): string {
  const p = ui.profile;
  const range = dateRange(ui.start, ui.end > ui.start ? ui.end : ui.start);
  const existing = range.filter((d) => p.bills[d]);
  const n = active().length;
  const future = plannedDates().some((d) => d >= today());
  const c = counts(p.bills);
  return `<section class="card">
    <div class="head"><h2>Build</h2></div>
    <div class="daterow">
      <label>From<input type="date" id="start" value="${ui.start}"></label>
      <label>To<input type="date" id="end" value="${ui.end}"></label>
      <div class="chips"><button class="sm" data-range="1">1 day</button><button class="sm" data-range="7">1 week</button><button class="sm" data-range="14">2 weeks</button>
      ${plannedDates().length ? `<button class="sm" data-act="extend">Next after ${militaryDate(plannedDates().pop()!)}</button>` : ''}</div>
    </div>
    <div class="actions">
      <button class="primary" data-act="generate" ${n ? '' : 'disabled'}>${existing.length ? `Rebuild ${range.length} day${range.length > 1 ? 's' : ''}` : `Generate ${range.length} day${range.length > 1 ? 's' : ''}`}</button>
      ${existing.length ? `<button data-act="print">Print ${existing.length} page${existing.length > 1 ? 's' : ''}</button>` : ''}
    </div>
    ${n ? '' : '<p class="muted small">Add people on the Roster tab first.</p>'}
    ${existing.length ? '<p class="muted small">Rebuilding keeps as much of the current bill as it can.</p>' : ''}
  </section>
  ${p.prefsChanged && future ? `<div class="notice"><span>Preferences changed since the bills were built.</span><button class="sm primary" data-act="apply-prefs">Apply from today</button></div>` : ''}
  ${ui.warnings.length ? `<details class="card warn" open><summary>${ui.warnings.length} warning${ui.warnings.length > 1 ? 's' : ''}</summary><ul>${ui.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
  ${existing.length ? `<p class="muted small center">Tap a name to swap it. <b>!</b> marks a watch that had to break a rule.</p>
  <div class="sheets">${existing.map((d) => sheet(d, p.bills, true)).join('')}</div>` : ''}
  ${c.size ? `<details class="card"><summary>Watch counts</summary><div class="table-scroll"><table class="counts">
    <tr><th>Name</th><th>Watches</th><th>Nights</th><th>Super</th><th>Double</th></tr>
    ${p.people
      .filter((x) => c.has(x.id))
      .sort((a, b) => c.get(b.id)!.regular - c.get(a.id)!.regular)
      .map((x) => {
        const k = c.get(x.id)!;
        return `<tr><td>${esc(x.name)}</td><td>${k.regular}</td><td>${k.nights}</td><td>${k.supers}</td><td>${k.doubles || ''}</td></tr>`;
      })
      .join('')}</table></div></details>` : ''}`;
}

// Changes

function personOptions() {
  return active()
    .map((x) => `<option value="${x.id}">${esc(x.name)}</option>`)
    .join('');
}
function dateOptions(selected = '') {
  const t = today();
  const dates = plannedDates();
  const pick = selected || dates.find((d) => d >= t) || dates[dates.length - 1];
  return dates.map((d) => `<option value="${d}" ${d === pick ? 'selected' : ''}>${longDate(d)}</option>`).join('');
}

function changesTab(): string {
  const p = ui.profile;
  const mode = ui.changesMode;
  const seg = `<div class="seg">${(
    [
      ['appt', 'Appointment'],
      ['double', 'Double watch'],
      ['swap', 'Swap a name'],
    ] as const
  )
    .map(([m, l]) => `<button class="${mode === m ? 'on' : ''}" data-mode="${m}">${l}</button>`)
    .join('')}</div>`;
  let body = '';
  if (mode === 'appt') {
    body = `<section class="card">
      <p class="muted small">Takes the person off the watches they'll miss and re-balances every day from that date on. Earlier days stay as they are.</p>
      <div class="form2">
        <label>Name<select id="a-person"><option value="">Choose…</option>${personOptions()}</select></label>
        <label>Date<select id="a-date">${dateOptions()}</select></label>
      </div>
      <h3>Watches missed</h3>${toggles('appt', BLOCK_NAMES, (i) => ui.apptBlocks.includes(i), [...BLOCKS])}
      <label>Note <span class="muted">(optional)</span><input id="a-note"></label>
      <div class="actions"><button class="primary" data-act="add-appt">Add appointment</button></div>
    </section>
    ${p.appointments.length ? `<section class="card"><h3>Appointments</h3><ul class="list">${[...p.appointments]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((a) => `<li><span><b>${esc(name(a.personId))}</b> · ${longDate(a.date)} · ${a.blocks.map((b) => BLOCKS[b]).join(', ')}${a.note ? ` · ${esc(a.note)}` : ''}</span><button class="sm ghost" data-del-appt="${a.id}">Remove</button></li>`)
      .join('')}</ul></section>` : ''}`;
  } else if (mode === 'double') {
    body = `<section class="card">
      <p class="muted small">Discipline only: one extra watch with 6 hours of rest, marked DOUBLE on the bill. Normal builds never do this.</p>
      <div class="form2">
        <label>Name<select id="d-person"><option value="">Choose…</option>${personOptions()}</select></label>
        <label>Date<select id="d-date">${dateOptions()}</select></label>
        <label>Watch<select id="d-block">${BLOCKS.map((b, i) => `<option value="${i}">${BLOCK_NAMES[i]} ${b}</option>`).join('')}</select></label>
        <label>Reason <span class="muted">(optional)</span><input id="d-note"></label>
      </div>
      <p class="muted small" id="d-hint"></p>
      <div class="actions"><button class="primary" data-act="add-double">Assign double watch</button></div>
    </section>
    ${p.doubles.length ? `<section class="card"><h3>Double watches</h3><ul class="list">${[...p.doubles]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((d) => `<li><span><b>${esc(name(d.personId))}</b> · ${longDate(d.date)} · ${BLOCKS[d.block]}${d.note ? ` · ${esc(d.note)}` : ''}</span><button class="sm ghost" data-del-double="${d.id}">Remove</button></li>`)
      .join('')}</ul></section>` : ''}`;
  } else {
    const dates = plannedDates();
    if (!dates.includes(ui.swapDate)) ui.swapDate = dates.find((d) => d >= today()) ?? dates[dates.length - 1];
    body = `<section class="card">
      <div class="form2"><label>Date<select id="s-date">${dateOptions(ui.swapDate)}</select></label></div>
      <p class="muted small">Tap a name on the bill to replace it. Only people who keep every rest rule are offered.</p>
    </section>
    <div class="sheets">${sheet(ui.swapDate, p.bills, true)}</div>`;
  }
  return seg + body;
}

// History

function historyTab(): string {
  const dates = plannedDates().reverse();
  if (!dates.length) return '<section class="card"><p class="muted">Built bills show up here.</p></section>';
  return `<section class="card"><div class="head"><h2>History</h2><span class="muted">${dates.length} day${dates.length > 1 ? 's' : ''}</span></div>
  <div class="hist">${dates
    .map((d) => {
      const revs = revisionsOf(d);
      const r = revs.length - 1;
      return `<details data-date="${d}"><summary>
        <span class="hd">${longDate(d)}</span>
        <span class="tags">${r > 0 ? `<span class="pill">Rev ${r}</span>` : ''}${ui.profile.printed[d] ? '<span class="pill">Printed</span>' : ''}</span>
      </summary>
      <div class="hist-body">
        <div class="actions"><button class="sm primary" data-edit-date="${d}">Edit</button><button class="sm" data-print-date="${d}">Print</button></div>
        <div class="preview" data-preview="${d}"></div>
        ${revs.length > 1 ? `<details class="versions"><summary>${revs.length} versions</summary><ul class="list">${[...revs]
          .reverse()
          .map((v, i) => `<li><span>${esc(v.reason)}<br><small class="muted">${new Date(v.at).toLocaleString()}${v.changedAfterPrint.includes(d) ? ' · changed after printing' : ''}</small></span><button class="sm ghost" data-version="${v.id}|${d}">${i === 0 ? 'Current' : 'View'}</button></li>`)
          .join('')}</ul></details>` : ''}
      </div></details>`;
    })
    .join('')}</div></section>`;
}

// Settings

function settingsTab(): string {
  const s = ui.profile.settings;
  const person = (id: string, c: { label: string; phone: string }, label: string) =>
    `<div class="form2"><label>${label}<input data-set="${id}.label" value="${esc(c.label)}" placeholder="Last name"></label>
     <label>Phone<input data-set="${id}.phone" value="${esc(c.phone)}" inputmode="tel"></label></div>`;
  return `<section class="card"><h2>Duty section</h2>
    <div class="form2"><label>Section number<input data-set="section" value="${esc(s.section)}" inputmode="numeric"></label>
    <label>Coordinator<input data-set="coordinator" value="${esc(s.coordinator)}" placeholder="Last name"></label></div>
    ${person('sectionLead', s.sectionLead, 'Section lead')}
    ${s.deckLeads.map((c, i) => person(`deckLeads.${i}`, c, `Deck lead ${i + 1}`)).join('')}
    <p class="muted small">Saved as you type and printed on every bill. Emergency contacts and standing orders are built in.</p>
  </section>
  <section class="card"><h2>Backup</h2>
    <p class="muted small">Phones can clear website data (iPhone Safari after about a week unused unless the page is on the Home Screen). Download a backup now and then; it's encrypted with your save code.</p>
    <div class="actions"><button data-act="download">Download backup</button></div>
    <details><summary>Restore a backup</summary>
      <label>Backup file<input type="file" id="restore-file" accept=".json,application/json"></label>
      <label>Save code for that backup<input id="restore-code" autocomplete="off" spellcheck="false"></label>
      <div class="actions"><button data-act="restore">Replace this profile with the backup</button></div>
    </details>
    <details><summary>Delete this profile from this device</summary>
      <label>Type DELETE to confirm<input id="confirm-delete" autocomplete="off"></label>
      <div class="actions"><button class="danger" data-act="delete-profile">Delete</button></div>
    </details>
  </section>
  <div class="actions"><button class="ghost" data-act="lock">Lock</button></div>`;
}

/** Scale the fixed-size printed pages down to fit the screen. */
function fitSheets() {
  fitNames(app);
  for (const wrap of document.querySelectorAll<HTMLElement>('.sheet-wrap')) {
    const sheetEl = wrap.firstElementChild as HTMLElement;
    const scale = Math.min(1, wrap.clientWidth / sheetEl.offsetWidth);
    sheetEl.style.transform = `scale(${scale})`;
    wrap.style.height = `${sheetEl.offsetHeight * scale}px`;
  }
}
window.addEventListener('resize', fitSheets);

// ---------- actions ----------

function download(filename: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function readFile(input: HTMLInputElement): Promise<BackupFile | null> {
  const f = input.files?.[0];
  if (!f) return null;
  try {
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}

function printDates(dates: string[], bills: Bills, revisionOverride?: string) {
  printArea.innerHTML = dates
    .filter((d) => bills[d])
    .map((d) => {
      const r = revisionOverride ? { n: 0, reason: revisionOverride } : revisionOf(d);
      return renderBill(bills[d], ui.profile, { revision: r.n, revisionReason: r.reason });
    })
    .join('');
  printArea.classList.add('measuring');
  fitNames(printArea);
  printArea.classList.remove('measuring');
  if (!revisionOverride) {
    const now = new Date().toISOString();
    for (const d of dates) if (bills[d]) ui.profile.printed[d] = now;
    changed();
  }
  window.print();
}

function openSwap(date: string, block: number, role: Role) {
  const p = ui.profile;
  const options = replacements(p.bills, p.people, p.appointments, date, block, role);
  const bill = p.bills[date];
  const cellIn = (b: DayBill): Cell => (block < 0 ? (role === 'superMoow' ? b.superMoow : b.superRover) : b.blocks[block][role as Pos]);
  const cell = cellIn(bill);
  const where = `${longDate(date)} · ${block >= 0 ? `${BLOCKS[block]} ${POS_LABEL[role as Pos]}` : role === 'superMoow' ? 'Super (MOOW)' : 'Super (Rover)'}`;
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<h2>Replace ${esc(name(cell.personId))}</h2><p class="muted small">${where}${cell.forced ? `<br><b>Rule broken: ${esc(cell.forced)}</b>` : ''}</p>
    ${options.length ? `<ul class="pick">${options.map((o) => `<li><button data-pick="${o.id}"><span>${esc(o.name)}</span><small>${esc(o.room)}</small></button></li>`).join('')}</ul>` : '<p>Nobody else can take this watch without breaking a rest rule.</p>'}
    <div class="actions"><button class="ghost" data-close>Cancel</button></div>`;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const pick = t.closest<HTMLElement>('[data-pick]')?.dataset.pick;
    if (pick) {
      const next = structuredClone(bill);
      const c = cellIn(next);
      const from = name(c.personId);
      c.personId = pick;
      delete c.forced;
      delete c.double;
      commit({ [date]: next }, `Swap: ${from} → ${name(pick)}`);
    }
    if (pick || t.closest('[data-close]') || t === dlg) {
      dlg.close();
      dlg.remove();
      render();
    }
  });
}

async function startSession(code: string) {
  ui.session = { code, keys: await deriveKeys(code, await store.salt()) };
  askPersistent();
}

function addPerson() {
  const n = document.querySelector<HTMLInputElement>('#n')!;
  const r = document.querySelector<HTMLInputElement>('#r')!;
  const nameText = n.value.trim().toUpperCase();
  if (!nameText) return n.focus();
  ui.profile.people.push(newPerson(nameText, r.value.trim().toUpperCase()));
  changed();
  render();
  document.querySelector<HTMLInputElement>('#n')?.focus();
}

function prefsEdited() {
  if (plannedDates().length) ui.profile.prefsChanged = true;
  changed();
  render();
}

function showPreview(d: string, bills: Bills, label?: string) {
  const box = document.querySelector<HTMLElement>(`[data-preview="${d}"]`);
  if (!box || !bills[d]) return;
  box.innerHTML = sheet(d, bills, false, label);
  fitSheets();
}

app.addEventListener('submit', (e) => {
  if ((e.target as HTMLElement).id === 'add-person') {
    e.preventDefault();
    addPerson();
  }
});

app.addEventListener('toggle', (e) => {
  const det = e.target as HTMLDetailsElement;
  const d = det.dataset?.date;
  if (d && det.open && !det.querySelector('.sheet')) showPreview(d, ui.profile.bills);
}, true);

app.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLElement>('button, [data-cell]');
  if (!btn) return;
  const d = btn.dataset;
  const p = ui.profile;
  const sel = p.people.find((x) => x.id === ui.person);

  if (d.tab) {
    ui.tab = d.tab as Tab;
    ui.message = '';
    return render();
  }
  if (d.cell) {
    const [date, block, role] = d.cell.split('|');
    return openSwap(date, Number(block), role as Role);
  }
  if (d.range) {
    ui.end = addDays(ui.start, Number(d.range) - 1);
    return render();
  }
  if (d.person) {
    ui.person = d.person;
    return render();
  }
  if (d.edit) {
    ui.editing = d.edit;
    render();
    return document.querySelector<HTMLInputElement>('#e-name')?.focus();
  }
  if (d.restore) {
    p.people.find((x) => x.id === d.restore)!.active = true;
    changed();
    return render();
  }
  if (d.mode) {
    ui.changesMode = d.mode as typeof ui.changesMode;
    return render();
  }
  if (d.toggle === 'appt') {
    const i = Number(d.i);
    ui.apptBlocks = ui.apptBlocks.includes(i) ? ui.apptBlocks.filter((x) => x !== i) : [...ui.apptBlocks, i].sort();
    btn.classList.toggle('on');
    return;
  }
  if (d.toggle && sel) {
    const i = Number(d.i);
    const flip = (arr: number[]) => (arr.includes(i) ? arr.filter((x) => x !== i) : [...arr, i].sort());
    if (d.toggle === 'pos') sel.pref.pos = (['moow', 'rover', null] as const)[i];
    if (d.toggle === 'blocks') sel.pref.blocks = flip(sel.pref.blocks);
    if (d.toggle === 'days') sel.pref.days = flip(sel.pref.days);
    return prefsEdited();
  }
  if (d.editDate) {
    ui.tab = 'bill';
    ui.start = ui.end = d.editDate;
    render();
    return window.scrollTo(0, 0);
  }
  if (d.printDate) return printDates([d.printDate], p.bills);
  if (d.version) {
    const [id, date] = d.version.split('|');
    const v = p.history.find((x) => x.id === id)!;
    const latest = revisionsOf(date).pop()?.id === id;
    return showPreview(date, latest ? p.bills : v.bills, latest ? undefined : `${v.reason.split(':')[0]}, ${new Date(v.at).toLocaleDateString()}`);
  }
  if (d.delAppt) {
    p.appointments = p.appointments.filter((a) => a.id !== d.delAppt);
    ui.message = 'Appointment removed. The bill stays as it is; swap names or rebuild if needed.';
    changed();
    return render();
  }
  if (d.delDouble) {
    const dw = p.doubles.find((x) => x.id === d.delDouble)!;
    p.doubles = p.doubles.filter((x) => x.id !== d.delDouble);
    resolveFrom(dw.date, `Double watch removed: ${name(dw.personId)}`);
    return render();
  }

  // Let the button react before the (briefly blocking) solve runs.
  if (['generate', 'apply-prefs', 'add-appt', 'add-double'].includes(d.act ?? '')) {
    (btn as HTMLButtonElement).disabled = true;
    btn.textContent = 'Working…';
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }

  switch (d.act) {
    case 'dismiss':
      ui.message = '';
      return render();
    case 'lock':
      clearTimeout(saveTimer);
      if (ui.session) await save(store, ui.session.keys, ui.profile);
      ui.session = null;
      ui.profile = emptyProfile();
      ui.message = '';
      return render();
    case 'create':
      ui.newCode = generateCode();
      return render();
    case 'start-new': {
      const code = ui.newCode!;
      ui.newCode = null;
      ui.busy = 'Creating…';
      render();
      await startSession(code);
      ui.profile = emptyProfile();
      ui.busy = '';
      ui.tab = 'roster';
      changed();
      return render();
    }
    case 'restore-login':
    case 'restore': {
      const file = await readFile(document.querySelector('#restore-file') as HTMLInputElement);
      const code = (document.querySelector('#restore-code') as HTMLInputElement).value;
      const restored = file && (await readBackup(file, code));
      if (!restored) {
        ui.message = 'Could not open that backup. Check the file and its save code.';
        return render();
      }
      if (d.act === 'restore-login') await startSession(code);
      else if (!confirm('Replace everything in this profile with the backup?')) return;
      ui.profile = migrate(restored);
      ui.message = 'Backup restored.';
      changed();
      return render();
    }
    case 'download': {
      const file = await makeBackup(ui.session!.code, p);
      download(`watchbill-backup-${today()}.json`, JSON.stringify(file));
      return;
    }
    case 'delete-profile':
      if ((document.querySelector('#confirm-delete') as HTMLInputElement).value !== 'DELETE') return;
      clearTimeout(saveTimer);
      await store.remove(ui.session!.keys.id);
      ui.session = null;
      ui.profile = emptyProfile();
      ui.message = 'Profile deleted from this device.';
      return render();
    case 'generate': {
      const dates = dateRange(ui.start, ui.end > ui.start ? ui.end : ui.start);
      p.prefsChanged = false;
      ui.tab = 'bill';
      runSolve(dates, `Built ${militaryDate(dates[0])}${dates.length > 1 ? `–${militaryDate(dates[dates.length - 1])}` : ''}`);
      return render();
    }
    case 'apply-prefs':
      p.prefsChanged = false;
      resolveFrom(today(), 'Preferences applied');
      return render();
    case 'extend': {
      const last = plannedDates().pop()!;
      const len = Math.max(1, dateRange(ui.start, ui.end).length);
      ui.start = addDays(last, 1);
      ui.end = addDays(last, len);
      return render();
    }
    case 'print':
      return printDates(dateRange(ui.start, ui.end), p.bills);
    case 'save-person': {
      const x = p.people.find((y) => y.id === ui.editing)!;
      x.name = (document.querySelector('#e-name') as HTMLInputElement).value.trim().toUpperCase() || x.name;
      x.room = (document.querySelector('#e-room') as HTMLInputElement).value.trim().toUpperCase();
      ui.editing = null;
      changed();
      return render();
    }
    case 'remove-person': {
      const x = p.people.find((y) => y.id === ui.editing)!;
      ui.editing = null;
      const used = JSON.stringify(p.bills).includes(`"${x.id}"`);
      if (used) {
        x.active = false;
        resolveFrom(today(), `${x.name} removed`);
      } else {
        p.people = p.people.filter((y) => y.id !== x.id);
        changed();
      }
      return render();
    }
    case 'clear-prefs':
      if (sel) sel.pref = { pos: null, blocks: [], days: [] };
      return prefsEdited();
    case 'add-appt': {
      const personId = (document.querySelector('#a-person') as HTMLSelectElement).value;
      const date = (document.querySelector('#a-date') as HTMLSelectElement).value;
      if (!personId || !date || !ui.apptBlocks.length) {
        ui.message = 'Choose a name, a date and at least one watch.';
        return render();
      }
      p.appointments.push({ id: newId(), personId, date, blocks: ui.apptBlocks, note: (document.querySelector('#a-note') as HTMLInputElement).value });
      ui.apptBlocks = [];
      resolveFrom(date, `Appointment: ${name(personId)} ${militaryDate(date)}`);
      return render();
    }
    case 'add-double': {
      const personId = (document.querySelector('#d-person') as HTMLSelectElement).value;
      const date = (document.querySelector('#d-date') as HTMLSelectElement).value;
      const block = Number((document.querySelector('#d-block') as HTMLSelectElement).value);
      if (!personId || !date) {
        ui.message = 'Choose a name and a date.';
        return render();
      }
      p.doubles.push({ id: newId(), personId, date, block, note: (document.querySelector('#d-note') as HTMLInputElement).value });
      resolveFrom(date, `Double watch: ${name(personId)} ${militaryDate(date)} ${BLOCKS[block]}`);
      return render();
    }
  }
});

app.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const cell = t.closest<HTMLElement>('[data-cell]');
  if (cell && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    cell.click();
  }
  if (e.key === 'Enter' && (t.id === 'e-name' || t.id === 'e-room')) document.querySelector<HTMLElement>('[data-act="save-person"]')?.click();
  if (e.key === 'Escape' && ui.editing) {
    ui.editing = null;
    render();
  }
});

app.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  const path = t.dataset.set;
  if (!path) return;
  const parts = path.split('.');
  let obj: any = ui.profile.settings;
  for (const k of parts.slice(0, -1)) obj = obj[k];
  obj[parts[parts.length - 1]] = t.value;
  changed();
});

app.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'start' || t.id === 'end') {
    ui[t.id] = t.value;
    if (ui.end < ui.start) ui.end = ui.start;
    render();
  }
  if (t.id === 's-date') {
    ui.swapDate = t.value;
    render();
  }
  if (t.id === 'd-person' || t.id === 'd-date') doubleHint();
});

/** Show where the person already stands watch near that date, so the double lands 6 hours from one of them. */
function doubleHint() {
  const pid = (document.querySelector('#d-person') as HTMLSelectElement)?.value;
  const date = (document.querySelector('#d-date') as HTMLSelectElement)?.value;
  const hint = document.querySelector('#d-hint');
  if (!hint || !pid || !date) return;
  const mine: string[] = [];
  for (const dd of [addDays(date, -1), date, addDays(date, 1)]) {
    ui.profile.bills[dd]?.blocks.forEach((row, i) => Object.values(row).forEach((c) => c.personId === pid && mine.push(`${militaryDate(dd)} ${BLOCKS[i]}`)));
  }
  hint.textContent = mine.length ? `Already on: ${mine.join(', ')}. Pick a watch 6 hours from one of these.` : 'No watches near this date.';
}

window.addEventListener('afterprint', () => (printArea.innerHTML = ''));

/** GitHub Pages caches the page for up to 10 minutes; fetch it fresh and switch to a newer build on its own. */
async function checkForUpdate() {
  try {
    const mine = [...document.scripts].map((s) => s.src).find((s) => /\/assets\/index-[\w-]+\.js/.test(s));
    if (!mine) return;
    const html = await (await fetch(`${location.pathname}?v=${Date.now()}`, { cache: 'no-store' })).text();
    const latest = html.match(/assets\/index-[\w-]+\.js/)?.[0];
    if (!latest || mine.endsWith(latest)) return;
    if (!ui.session) return location.reload();
    ui.message = 'A new version is ready. It will load the next time you lock or reopen.';
    render();
  } catch {
    /* offline: keep going */
  }
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkForUpdate());
checkForUpdate();
render();
