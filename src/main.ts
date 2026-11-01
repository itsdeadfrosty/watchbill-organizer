import './style.css';
import { esc, fitNames, renderBill } from './bill';
import { deriveKeys, generateCode, isValidCode, type Keys } from './crypto';
import { addDays, dateRange, longDate, militaryDate, today, WEEKDAYS } from './dates';
import { BLOCKS, emptyProfile, newId, newPerson, POS_LABEL, type Bills, type Cell, type DayBill, type Person, type Pos } from './model';
import { counts, replacements, solve, type Role } from './scheduler';
import { askPersistent, DeviceStore, makeBackup, readBackup, save, unlock, type BackupFile } from './storage';

type Tab = 'bill' | 'roster' | 'prefs' | 'changes' | 'setup' | 'history' | 'backup';
const TABS: [Tab, string][] = [
  ['bill', 'Bill'],
  ['roster', 'Roster'],
  ['prefs', 'Preferences'],
  ['changes', 'Appointments'],
  ['setup', 'Leads & notes'],
  ['history', 'History'],
  ['backup', 'Backup'],
];

const store = new DeviceStore();
const app = document.querySelector<HTMLDivElement>('#app')!;
const printArea = document.querySelector<HTMLDivElement>('#print-area')!;

const ui = {
  session: null as null | { code: string; keys: Keys },
  profile: emptyProfile(),
  tab: 'bill' as Tab,
  start: today(),
  end: addDays(today(), 6),
  warnings: [] as string[],
  person: null as string | null,
  viewRevision: null as string | null,
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
      ui.saved = 'Saved on this device';
    } catch (e) {
      ui.saved = `Save failed: ${(e as Error).message}`;
    }
    setStatus();
  }, 600);
}

function setStatus() {
  const el = document.querySelector('#status');
  if (el) el.textContent = ui.saved;
}

// ---------- scheduling helpers ----------

function name(id: string | null | undefined): string {
  return ui.profile.people.find((p) => p.id === id)?.name ?? '(nobody)';
}

function plannedDates(): string[] {
  return Object.keys(ui.profile.bills).sort();
}

function sameBill(a?: DayBill, b?: DayBill) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function commit(newBills: Bills, reason: string, warnings: string[] = []) {
  const p = ui.profile;
  const dates = Object.keys(newBills).sort();
  const changedDates = dates.filter((d) => !sameBill(p.bills[d], newBills[d]));
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
  ui.message = changedDates.length ? `${reason}: ${changedDates.length} day(s) updated.` : `${reason}: no changes needed.`;
  changed();
}

function runSolve(dates: string[], reason: string) {
  if (!dates.length) {
    ui.message = `${reason}. No planned bills from that date on, so nothing to re-solve.`;
    changed();
    return;
  }
  const p = ui.profile;
  const res = solve({ dates, people: p.people, appointments: p.appointments, doubles: p.doubles, bills: p.bills, seed: p.seed });
  commit(res.bills, reason, res.warnings);
}

/** Re-solve every planned day from `date` forward; earlier days stay fixed. */
function resolveFrom(date: string, reason: string) {
  runSolve(plannedDates().filter((d) => d >= date), reason);
}

function revisionOf(date: string): { n: number; reason?: string } {
  const revs = ui.profile.history.filter((h) => h.dates.includes(date));
  return { n: Math.max(0, revs.length - 1), reason: revs.length > 1 ? revs[revs.length - 1].reason.split(':')[0] : undefined };
}

// ---------- rendering ----------

function render() {
  if (!ui.session) return renderLogin();
  app.innerHTML = `
  <header class="top">
    <div class="brand">Watchbill Organizer</div>
    <div id="status" class="status">${esc(ui.saved)}</div>
    <button class="ghost" data-act="lock">Lock</button>
  </header>
  <nav class="tabs">${TABS.map(([t, l]) => `<button class="${ui.tab === t ? 'on' : ''}" data-tab="${t}">${l}</button>`).join('')}</nav>
  ${ui.message ? `<div class="message">${esc(ui.message)} <button class="link" data-act="dismiss">dismiss</button></div>` : ''}
  <main>${{ bill: billTab, roster: rosterTab, prefs: prefsTab, changes: changesTab, setup: setupTab, history: historyTab, backup: backupTab }[ui.tab]()}</main>`;
  fitSheets();
}

function renderLogin() {
  if (ui.newCode) {
    app.innerHTML = `<div class="login card">
      <h1>Your save code</h1>
      <p class="code">${ui.newCode}</p>
      <p><b>Write this down now.</b> It is the only way to open your data. It is never stored, so if you lose it there is no recovery.</p>
      <label class="check"><input type="checkbox" id="wrote"> I wrote it down</label>
      <button class="primary" data-act="start-new" disabled id="go">Continue</button>
    </div>`;
    document.querySelector('#wrote')!.addEventListener('change', (e) => {
      (document.querySelector('#go') as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked;
    });
    return;
  }
  app.innerHTML = `<div class="login card">
    <h1>Watchbill Organizer</h1>
    <p class="muted">Everything is saved encrypted on this device only. Without the save code the data can't be read, even by someone holding the device.</p>
    <form id="login">
      <input type="text" name="username" autocomplete="username" value="watchbill" hidden>
      <label>Save code<input id="code" name="password" type="password" autocomplete="current-password" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH-JKLM-NPQR"></label>
      <button class="primary" ${ui.busy ? 'disabled' : ''}>${ui.busy || 'Open'}</button>
    </form>
    ${ui.message ? `<p class="error">${esc(ui.message)}</p>` : ''}
    <hr>
    <button data-act="create">Create new profile</button>
    <details><summary>Restore from a backup file</summary>
      <label>Backup file<input type="file" id="restore-file" accept=".json,application/json"></label>
      <label>Save code for that backup<input id="restore-code" autocomplete="off" spellcheck="false"></label>
      <button data-act="restore-login">Restore</button>
    </details>
  </div>`;
  document.querySelector('#login')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = (document.querySelector('#code') as HTMLInputElement).value;
    if (!isValidCode(code)) {
      ui.message = 'That is not a valid save code (16 letters and numbers).';
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
    ui.profile = res.profile;
    ui.saved = 'Opened';
    askPersistent();
    render();
  });
}

function sheetsFor(dates: string[], bills: Bills, interactive: boolean, revisionOverride?: string) {
  return dates
    .filter((d) => bills[d])
    .map((d) => {
      const r = revisionOverride ? { n: 0, reason: revisionOverride } : revisionOf(d);
      return `<div class="sheet-wrap">${renderBill(bills[d], ui.profile, { revision: r.n, revisionReason: r.reason, interactive })}</div>`;
    })
    .join('');
}

function billTab(): string {
  const p = ui.profile;
  const planned = plannedDates();
  const inRange = dateRange(ui.start, ui.end > ui.start ? ui.end : ui.start);
  const existing = inRange.filter((d) => p.bills[d]);
  const active = p.people.filter((x) => x.active).length;
  const c = counts(p.bills);
  return `
  <section class="card">
    <h2>Dates</h2>
    <div class="row2">
      <label>From<input type="date" id="start" value="${ui.start}"></label>
      <label>To<input type="date" id="end" value="${ui.end}"></label>
    </div>
    <div class="chips">
      <button data-range="1">1 day</button><button data-range="7">1 week</button><button data-range="14">2 weeks</button>
      ${planned.length ? `<button data-act="extend">Continue after ${militaryDate(planned[planned.length - 1])}</button>` : ''}
    </div>
    <button class="primary" data-act="generate" ${active ? '' : 'disabled'}>${existing.length ? `Rebuild ${inRange.length} day(s)` : `Generate ${inRange.length} day(s)`}</button>
    ${active ? '' : '<p class="muted">Add names on the Roster tab first.</p>'}
    ${existing.length ? `<p class="muted">${existing.length} of these days already have a bill. Rebuilding keeps as much of them as it can.</p>` : ''}
  </section>
  ${ui.warnings.length ? `<section class="card warn"><h2>Warnings</h2><ul>${ui.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>` : ''}
  <section class="card">
    <div class="spread"><h2>Preview</h2>${existing.length ? `<button class="primary" data-act="print">Print ${existing.length} page(s)</button>` : ''}</div>
    ${existing.length ? '<p class="muted">Tap a name to swap it with someone who keeps every rule. A ! marks a watch that broke a rule because nobody else was free.</p>' : '<p class="muted">No bills for these dates yet.</p>'}
    <div class="sheets">${sheetsFor(inRange, p.bills, true)}</div>
  </section>
  ${c.size ? `<section class="card"><h2>Watch counts (all bills)</h2><div class="table-scroll"><table class="counts">
    <tr><th>Name</th><th>Watches</th><th>2400-0600</th><th>Super</th><th>Double</th></tr>
    ${p.people
      .filter((x) => c.has(x.id))
      .sort((a, b) => c.get(b.id)!.regular - c.get(a.id)!.regular)
      .map((x) => {
        const k = c.get(x.id)!;
        return `<tr><td>${esc(x.name)}</td><td>${k.regular}</td><td>${k.nights}</td><td>${k.supers}</td><td>${k.doubles || ''}</td></tr>`;
      })
      .join('')}</table></div></section>` : ''}`;
}

function rosterTab(): string {
  const p = ui.profile;
  const sel = p.people.find((x) => x.id === ui.person);
  return `
  <section class="card">
    <h2>Add names</h2>
    <p class="muted">One per line, as it should print, with the room last: <code>SHAW, A. 164</code>. Rooms like <code>3910-548</code> or <code>O/B</code> work too.</p>
    <textarea id="paste" rows="6" placeholder="LAST, F. 123"></textarea>
    <button class="primary" data-act="add-names">Add</button>
  </section>
  <section class="card">
    <h2>Roster (${p.people.filter((x) => x.active).length} active)</h2>
    <div class="namelist">${p.people
      .map((x) => `<button class="${x.active ? '' : 'inactive'} ${x.id === ui.person ? 'on' : ''}" data-person="${x.id}">${esc(x.name)}${x.room ? ` <small>${esc(x.room)}</small>` : ''}</button>`)
      .join('')}</div>
    ${sel ? `<div class="editor">
      <div class="row2"><label>Name<input id="p-name" value="${esc(sel.name)}"></label><label>Room<input id="p-room" value="${esc(sel.room)}"></label></div>
      <label class="check"><input type="checkbox" id="p-active" ${sel.active ? 'checked' : ''}> Active (off = left the section; kept in history)</label>
      <div class="chips"><button class="primary" data-act="save-person">Save</button><button class="danger" data-act="delete-person">Remove</button></div>
    </div>` : ''}
  </section>`;
}

function toggles(group: string, items: string[], on: (i: number) => boolean) {
  return `<div class="toggles">${items.map((l, i) => `<button class="${on(i) ? 'on' : ''}" data-toggle="${group}" data-i="${i}">${l}</button>`).join('')}</div>`;
}

let draft: Person | null = null;
function prefsTab(): string {
  const p = ui.profile;
  const sel = p.people.find((x) => x.id === ui.person) ?? null;
  if (sel && draft?.id !== sel.id) draft = structuredClone(sel);
  if (!sel) draft = null;
  return `<div class="split">
    <section class="card namecol"><h2>Names</h2><div class="namelist vertical">${p.people
      .filter((x) => x.active)
      .map((x) => `<button class="${x.id === ui.person ? 'on' : ''}" data-person="${x.id}">${esc(x.name)}</button>`)
      .join('')}</div></section>
    <section class="card">${
      draft
        ? `<h2>${esc(draft.name)}</h2>
      <h3>Position</h3>${toggles('pos', ['Moow', 'Rover', 'No preference'], (i) => (i === 0 ? draft!.pref.pos === 'moow' : i === 1 ? draft!.pref.pos === 'rover' : draft!.pref.pos === null))}
      <h3>Watch</h3>${toggles('blocks', [...BLOCKS], (i) => draft!.pref.blocks.includes(i))}
      <h3>Days</h3>${toggles('days', WEEKDAYS, (i) => draft!.pref.days.includes(i))}
      <h3>Qualified for</h3>${toggles('elig', ['Moow', 'Rover', 'Super (Moow)', 'Super (Rover)'], (i) => [draft!.elig.moow, draft!.elig.rover, draft!.elig.superMoow, draft!.elig.superRover][i])}
      <p class="muted">The watch preference counts most, then position, then day. None is guaranteed, because every watch must be filled. "Qualified for" is a hard rule.</p>
      <button class="primary" data-act="save-prefs">Save and re-shift from today</button>`
        : '<p class="muted">Pick a name.</p>'
    }</section></div>`;
}

function personOptions() {
  return ui.profile.people
    .filter((x) => x.active)
    .map((x) => `<option value="${x.id}">${esc(x.name)}</option>`)
    .join('');
}

const apptDraft = { blocks: [] as number[] };
function changesTab(): string {
  const p = ui.profile;
  return `
  <section class="card">
    <h2>Appointment</h2>
    <p class="muted">Takes the person off the watches they'll miss and re-solves every day from that date on. Works on past dates too; then reprint.</p>
    <label>Name<select id="a-person"><option value="">Pick a name</option>${personOptions()}</select></label>
    <label>Date<input type="date" id="a-date" value="${today()}"></label>
    <h3>Watches missed</h3>${toggles('appt', [...BLOCKS], (i) => apptDraft.blocks.includes(i))}
    <label>Note (optional)<input id="a-note"></label>
    <button class="primary" data-act="add-appt">Add appointment</button>
    <ul class="list">${[...p.appointments]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((a) => `<li><span><b>${esc(name(a.personId))}</b> · ${longDate(a.date)} · ${a.blocks.map((b) => BLOCKS[b]).join(', ')}${a.note ? ` · ${esc(a.note)}` : ''}</span><button class="link" data-del-appt="${a.id}">remove</button></li>`)
      .join('')}</ul>
  </section>
  <section class="card">
    <h2>Double watch</h2>
    <p class="muted">Discipline only. Adds one extra watch with just 6 hours of rest, marked DOUBLE on the bill and in history. Normal generation never does this.</p>
    <label>Name<select id="d-person"><option value="">Pick a name</option>${personOptions()}</select></label>
    <label>Date<input type="date" id="d-date" value="${today()}"></label>
    <label>Watch<select id="d-block">${BLOCKS.map((b, i) => `<option value="${i}">${b}</option>`).join('')}</select></label>
    <p class="muted" id="d-hint"></p>
    <label>Reason (optional)<input id="d-note"></label>
    <button class="primary" data-act="add-double">Assign double watch</button>
    <ul class="list">${[...p.doubles]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((d) => `<li><span><b>${esc(name(d.personId))}</b> · ${longDate(d.date)} · ${BLOCKS[d.block]}${d.note ? ` · ${esc(d.note)}` : ''}</span><button class="link" data-del-double="${d.id}">remove</button></li>`)
      .join('')}</ul>
  </section>`;
}

function setupTab(): string {
  const s = ui.profile.settings;
  const pair = (id: string, c: { label: string; phone: string }, labelText: string, placeholder: string) =>
    `<div class="row2"><label>${labelText}<input data-set="${id}.label" value="${esc(c.label)}" placeholder="${placeholder}"></label>
     <label>Phone<input data-set="${id}.phone" value="${esc(c.phone)}" inputmode="tel"></label></div>`;
  return `
  <section class="card"><h2>Duty section</h2>
    <label>Duty section number<input data-set="section" value="${esc(s.section)}"></label>
    ${pair('sectionLead', s.sectionLead, 'Duty section lead', 'Last name')}
    ${s.deckLeads.map((c, i) => pair(`deckLeads.${i}`, c, `Deck lead ${i + 1}`, 'Last name')).join('')}
    <label>Bill coordinator<input data-set="coordinator" value="${esc(s.coordinator)}"></label>
  </section>
  <section class="card"><h2>For emergencies</h2>
    ${s.emergencies.map((c, i) => pair(`emergencies.${i}`, c, `Label ${i + 1}`, 'e.g. Base police')).join('')}
  </section>
  <section class="card"><h2>Standing orders</h2>
    <p class="muted">One per line. Prints as a numbered list.</p>
    <textarea data-set="notes" rows="10">${esc(s.notes)}</textarea>
    <label>Bottom banner<input data-set="banner" value="${esc(s.banner)}" placeholder="e.g. Report 30 minutes before watch start"></label>
  </section>
  <p class="muted">Saved automatically and reused on every bill.</p>`;
}

function historyTab(): string {
  const h = [...ui.profile.history].reverse();
  const view = ui.profile.history.find((r) => r.id === ui.viewRevision);
  return `
  ${view ? `<section class="card"><div class="spread"><h2>${esc(view.reason)}</h2><span><button data-act="print-revision">Print</button> <button class="ghost" data-act="close-revision">Close</button></span></div>
    <p class="muted">${new Date(view.at).toLocaleString()} · as it stood after this change</p>
    <div class="sheets">${sheetsFor(view.dates, view.bills, false, view.reason)}</div></section>` : ''}
  <section class="card"><h2>History</h2>
    ${h.length ? '' : '<p class="muted">Nothing yet. Every generate and change is kept here.</p>'}
    <ul class="list">${h
      .map(
        (r) => `<li><span><b>${esc(r.reason)}</b><br><small>${new Date(r.at).toLocaleString()} · ${r.dates.map(militaryDate).join(', ')}${
          r.changedAfterPrint.length ? ` · <b class="flag">changed after printing: ${r.changedAfterPrint.map(militaryDate).join(', ')}</b>` : ''
        }</small></span><button class="link" data-view="${r.id}">open</button></li>`,
      )
      .join('')}</ul>
  </section>`;
}

function backupTab(): string {
  return `
  <section class="card"><h2>Backup file</h2>
    <p class="muted">Phone browsers can wipe site data, for example iPhone Safari after about a week unused unless the page is added to the Home Screen. Download a backup now and then. The file is encrypted with your save code.</p>
    <button class="primary" data-act="download">Download backup</button>
  </section>
  <section class="card"><h2>Restore</h2>
    <p class="muted">Replaces everything in this profile with the backup.</p>
    <label>Backup file<input type="file" id="restore-file" accept=".json,application/json"></label>
    <label>Save code for that backup<input id="restore-code" autocomplete="off" spellcheck="false"></label>
    <button data-act="restore">Restore into this profile</button>
  </section>
  <section class="card"><h2>Delete</h2>
    <p class="muted">Removes this profile from this device. Type DELETE to confirm.</p>
    <input id="confirm-delete" autocomplete="off">
    <button class="danger" data-act="delete-profile">Delete profile from this device</button>
  </section>`;
}

/** Scale the fixed-size printed pages down to fit the screen. */
function fitSheets() {
  fitNames(app);
  for (const wrap of document.querySelectorAll<HTMLElement>('.sheet-wrap')) {
    const sheet = wrap.firstElementChild as HTMLElement;
    const scale = Math.min(1, wrap.clientWidth / sheet.offsetWidth);
    sheet.style.transform = `scale(${scale})`;
    wrap.style.height = `${sheet.offsetHeight * scale}px`;
  }
}
window.addEventListener('resize', fitSheets);

// ---------- actions ----------

function parseNames(text: string): Person[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(.*?)\s+(\d[\w/-]*|O\/?B)$/i);
      return m ? newPerson(m[1].trim().toUpperCase(), m[2].toUpperCase()) : newPerson(l.toUpperCase());
    });
}

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
  const where = `${longDate(date)} ${block >= 0 ? BLOCKS[block] + ' ' + POS_LABEL[role as Pos] : role === 'superMoow' ? 'SUPER (MOOW)' : 'SUPER (ROVER)'}`;
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<h2>Swap ${esc(name(cell.personId))}</h2><p class="muted">${where}${cell.forced ? `<br><b>Rule broken: ${esc(cell.forced)}</b>` : ''}</p>
    ${options.length ? `<div class="namelist">${options.map((o) => `<button data-pick="${o.id}">${esc(o.name)}</button>`).join('')}</div>` : '<p>Nobody else can take this watch without breaking a rule.</p>'}
    <button class="ghost" data-close>Cancel</button>`;
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
      commit({ [date]: next }, `Manual swap: ${from} → ${name(pick)}`);
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

app.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLElement>('button, [data-cell]');
  if (!btn) return;
  const d = btn.dataset;
  const p = ui.profile;

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
  if (d.toggle === 'appt') {
    const i = Number(d.i);
    apptDraft.blocks = apptDraft.blocks.includes(i) ? apptDraft.blocks.filter((x) => x !== i) : [...apptDraft.blocks, i].sort();
    btn.classList.toggle('on');
    return;
  }
  if (d.toggle && draft) {
    const i = Number(d.i);
    const flip = (arr: number[]) => (arr.includes(i) ? arr.filter((x) => x !== i) : [...arr, i].sort());
    if (d.toggle === 'pos') draft.pref.pos = (['moow', 'rover', null] as const)[i];
    if (d.toggle === 'blocks') draft.pref.blocks = flip(draft.pref.blocks);
    if (d.toggle === 'days') draft.pref.days = flip(draft.pref.days);
    if (d.toggle === 'elig') {
      const k = (['moow', 'rover', 'superMoow', 'superRover'] as const)[i];
      draft.elig[k] = !draft.elig[k];
    }
    return render();
  }
  if (d.view) {
    ui.viewRevision = d.view;
    render();
    return window.scrollTo(0, 0);
  }
  if (d.delAppt) {
    p.appointments = p.appointments.filter((a) => a.id !== d.delAppt);
    ui.message = 'Appointment removed. The bill is unchanged; swap names by hand or rebuild if needed.';
    changed();
    return render();
  }
  if (d.delDouble) {
    const dw = p.doubles.find((x) => x.id === d.delDouble)!;
    p.doubles = p.doubles.filter((x) => x.id !== d.delDouble);
    resolveFrom(dw.date, `Double watch removed: ${name(dw.personId)}`);
    return render();
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
      ui.profile = restored;
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
      runSolve(dates, `Generated ${militaryDate(dates[0])}–${militaryDate(dates[dates.length - 1])}`);
      return render();
    }
    case 'extend': {
      const last = plannedDates().pop()!;
      const len = Math.max(1, dateRange(ui.start, ui.end).length);
      ui.start = addDays(last, 1);
      ui.end = addDays(last, len);
      return render();
    }
    case 'print':
      return printDates(dateRange(ui.start, ui.end), p.bills);
    case 'print-revision': {
      const r = p.history.find((x) => x.id === ui.viewRevision);
      if (r) printDates(r.dates, r.bills, r.reason);
      return;
    }
    case 'close-revision':
      ui.viewRevision = null;
      return render();
    case 'add-names': {
      const added = parseNames((document.querySelector('#paste') as HTMLTextAreaElement).value);
      p.people.push(...added);
      ui.message = `Added ${added.length} name(s).`;
      changed();
      return render();
    }
    case 'save-person': {
      const x = p.people.find((y) => y.id === ui.person)!;
      x.name = (document.querySelector('#p-name') as HTMLInputElement).value.trim().toUpperCase() || x.name;
      x.room = (document.querySelector('#p-room') as HTMLInputElement).value.trim().toUpperCase();
      const wasActive = x.active;
      x.active = (document.querySelector('#p-active') as HTMLInputElement).checked;
      if (wasActive && !x.active) resolveFrom(today(), `${x.name} made inactive`);
      changed();
      return render();
    }
    case 'delete-person': {
      const x = p.people.find((y) => y.id === ui.person)!;
      const used = JSON.stringify(p.bills).includes(`"${x.id}"`) || JSON.stringify(p.history).includes(`"${x.id}"`);
      if (used) {
        x.active = false;
        resolveFrom(today(), `${x.name} made inactive`);
        ui.message = `${x.name} is on past bills, so they were made inactive instead of removed.`;
      } else {
        p.people = p.people.filter((y) => y.id !== x.id);
        ui.person = null;
      }
      changed();
      return render();
    }
    case 'save-prefs': {
      const i = p.people.findIndex((y) => y.id === draft!.id);
      p.people[i] = structuredClone(draft!);
      resolveFrom(today(), `Preferences changed: ${draft!.name}`);
      return render();
    }
    case 'add-appt': {
      const personId = (document.querySelector('#a-person') as HTMLSelectElement).value;
      const date = (document.querySelector('#a-date') as HTMLInputElement).value;
      if (!personId || !date || !apptDraft.blocks.length) {
        ui.message = 'Pick a name, a date and at least one watch.';
        return render();
      }
      p.appointments.push({ id: newId(), personId, date, blocks: apptDraft.blocks, note: (document.querySelector('#a-note') as HTMLInputElement).value });
      apptDraft.blocks = [];
      resolveFrom(date, `Appointment added: ${name(personId)} ${militaryDate(date)}`);
      return render();
    }
    case 'add-double': {
      const personId = (document.querySelector('#d-person') as HTMLSelectElement).value;
      const date = (document.querySelector('#d-date') as HTMLInputElement).value;
      const block = Number((document.querySelector('#d-block') as HTMLSelectElement).value);
      if (!personId || !date) {
        ui.message = 'Pick a name and a date.';
        return render();
      }
      if (!p.bills[date]) {
        ui.message = 'Generate the bill for that date first.';
        return render();
      }
      p.doubles.push({ id: newId(), personId, date, block, note: (document.querySelector('#d-note') as HTMLInputElement).value });
      resolveFrom(date, `Double watch assigned: ${name(personId)} ${militaryDate(date)} ${BLOCKS[block]}`);
      return render();
    }
  }
});

app.addEventListener('keydown', (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
  if (cell && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    cell.click();
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
  if (t.id === 'd-person' || t.id === 'd-date') doubleHint();
});

/** Show where the person already stands watch near that date, so the double lands 6 hours from one of them. */
function doubleHint() {
  const pid = (document.querySelector('#d-person') as HTMLSelectElement)?.value;
  const date = (document.querySelector('#d-date') as HTMLInputElement)?.value;
  const hint = document.querySelector('#d-hint');
  if (!hint || !pid || !date) return;
  const mine: string[] = [];
  for (const dd of [addDays(date, -1), date, addDays(date, 1)]) {
    ui.profile.bills[dd]?.blocks.forEach((row, i) => Object.values(row).forEach((c) => c.personId === pid && mine.push(`${militaryDate(dd)} ${BLOCKS[i]}`)));
  }
  hint.textContent = mine.length ? `Already on: ${mine.join(', ')}. A double sits 6 hours from one of these.` : 'No watches near this date yet.';
}

window.addEventListener('afterprint', () => (printArea.innerHTML = ''));
render();
