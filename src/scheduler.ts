// Pure scheduling core: no DOM, no storage. Same inputs + seed => same bills.
//
// Time is measured in slots: slot = 4 * dayNum + block. Two watches by one
// person must be >= 3 slots apart (12 h rest); 2 apart (6 h) is only allowed
// when one of them is an explicit double watch; 1 apart is back-to-back.

import { dayNum, weekday, longDate } from './dates';
import {
  BLOCKS,
  POSITIONS,
  POS_LABEL,
  emptyBill,
  type Appointment,
  type Bills,
  type Cell,
  type DayBill,
  type DoubleWatch,
  type Person,
  type Pos,
} from './model';

export type Role = Pos | 'superMoow' | 'superRover';
const SUPERS: Role[] = ['superMoow', 'superRover'];

export interface SolveInput {
  /** Duty days to (re)build. Bills on other dates are fixed and only count for rest and fairness. */
  dates: string[];
  people: Person[];
  appointments: Appointment[];
  doubles: DoubleWatch[];
  /** Current bills. Inside `dates` they are the "before" picture the solver tries to keep. */
  bills: Bills;
  seed: number;
}

export interface SolveResult {
  bills: Bills;
  warnings: string[];
}

/** Penalty weights, highest priority first. */
export const W = {
  forced: 100000,
  load: 1000,
  superLoad: 600,
  sameDay: 400,
  nextDay: 150,
  twoDays: 40,
  block: 120,
  pos: 80,
  nights: 60,
  stability: 50,
  day: 20,
};

interface Asg {
  date: string;
  dn: number;
  block: number; // -1 for supers
  role: Role;
  slot: number;
  pid: string;
  locked: boolean;
  double: boolean;
  forced?: string;
}

interface Relax {
  minGap: number;
  elig: boolean;
  superDay: boolean;
  appt: boolean;
}
const STRICT: Relax = { minGap: 3, elig: false, superDay: false, appt: false };
const LEVELS: { relax: Relax; reason: string }[] = [
  { relax: STRICT, reason: '' },
  { relax: { ...STRICT, minGap: 2 }, reason: 'short rest (6 h)' },
  { relax: { ...STRICT, minGap: 2, elig: true }, reason: 'short rest or not qualified' },
  { relax: { minGap: 2, elig: true, superDay: true, appt: false }, reason: 'conflicts with super duty' },
  { relax: { minGap: 1, elig: true, superDay: true, appt: false }, reason: 'back-to-back watches' },
  { relax: { minGap: 1, elig: true, superDay: true, appt: true }, reason: 'during an appointment' },
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class State {
  byPerson = new Map<string, Asg[]>();
  people = new Map<string, Person>();
  appts = new Set<string>();
  apptDays = new Set<string>();
  prev: Bills;

  constructor(people: Person[], appointments: Appointment[], prev: Bills) {
    for (const p of people) {
      this.people.set(p.id, p);
      this.byPerson.set(p.id, []);
    }
    for (const a of appointments) {
      this.apptDays.add(`${a.personId}|${a.date}`);
      for (const b of a.blocks) this.appts.add(`${a.personId}|${a.date}|${b}`);
    }
    this.prev = prev;
  }

  list(pid: string): Asg[] {
    let l = this.byPerson.get(pid);
    if (!l) this.byPerson.set(pid, (l = []));
    return l;
  }
  add(a: Asg) {
    this.list(a.pid).push(a);
  }
  remove(a: Asg) {
    const l = this.list(a.pid);
    l.splice(l.indexOf(a), 1);
  }

  /** Can `pid` take a watch shaped like `a` (ignoring a's current occupant)? */
  canTake(pid: string, a: Asg, relax: Relax = STRICT, ignore?: Asg): boolean {
    const p = this.people.get(pid);
    if (!p || !p.active) return false;
    const isSuper = a.block < 0;
    if (!relax.elig) {
      const e = p.elig;
      if (a.role === 'moow' && !e.moow) return false;
      if ((a.role === 'rover1' || a.role === 'rover2') && !e.rover) return false;
      if (a.role === 'superMoow' && !e.superMoow) return false;
      if (a.role === 'superRover' && !e.superRover) return false;
    }
    if (!relax.appt) {
      if (isSuper ? this.apptDays.has(`${pid}|${a.date}`) : this.appts.has(`${pid}|${a.date}|${a.block}`)) return false;
    }
    for (const o of this.list(pid)) {
      if (o === a || o === ignore) continue;
      const oSuper = o.block < 0;
      if (isSuper && oSuper) {
        if (o.dn === a.dn) return false;
        continue;
      }
      if (isSuper || oSuper) {
        if (relax.superDay) continue;
        const s = isSuper ? a : o;
        const r = isSuper ? o : a;
        // Super stands the whole duty day; the 2400-0600 before it ends as it starts.
        if (r.dn === s.dn || (r.dn === s.dn - 1 && r.block === 3)) return false;
        continue;
      }
      const gap = Math.abs(o.slot - a.slot);
      if (gap === 0) return false;
      const min = a.double || o.double ? Math.min(2, relax.minGap) : relax.minGap;
      if (gap < min) return false;
    }
    return true;
  }

  cost(pid: string): number {
    const p = this.people.get(pid);
    const l = this.list(pid);
    if (!p || l.length === 0) return 0;
    let c = 0;
    let regular = 0;
    let supers = 0;
    let nights = 0;
    const days: number[] = [];
    for (const a of l) {
      if (a.forced) c += W.forced;
      if (a.block < 0) supers++;
      else if (!a.double) {
        regular++;
        if (a.block === 3) nights++;
      }
      if (!a.double) days.push(a.dn);
      if (a.locked) continue;
      if (a.block >= 0) {
        const pr = p.pref;
        if (pr.blocks.length && !pr.blocks.includes(a.block)) c += W.block;
        if (pr.pos === 'moow' && a.role !== 'moow') c += W.pos;
        if (pr.pos === 'rover' && a.role === 'moow') c += W.pos;
      }
      if (p.pref.days.length && !p.pref.days.includes(weekday(a.date))) c += W.day;
      const before = cellOf(this.prev[a.date], a)?.personId;
      if (before && before !== pid) c += W.stability;
    }
    c += W.load * regular * regular + W.superLoad * supers * supers;
    if (!p.pref.blocks.length) c += W.nights * nights * nights;
    days.sort((x, y) => x - y);
    for (let i = 1; i < days.length; i++) {
      const g = days[i] - days[i - 1];
      c += g === 0 ? W.sameDay : g === 1 ? W.nextDay : g === 2 ? W.twoDays : 0;
    }
    return c;
  }
}

function cellOf(bill: DayBill | undefined, a: { block: number; role: Role }): Cell | undefined {
  if (!bill) return undefined;
  if (a.role === 'superMoow') return bill.superMoow;
  if (a.role === 'superRover') return bill.superRover;
  return bill.blocks[a.block]?.[a.role as Pos];
}

function makeAsg(date: string, block: number, role: Role, pid: string): Asg {
  const dn = dayNum(date);
  return { date, dn, block, role, slot: block < 0 ? -1 : 4 * dn + block, pid, locked: false, double: false };
}

function nameOf(people: Person[], pid: string | null): string {
  return people.find((p) => p.id === pid)?.name ?? '(nobody)';
}

function where(date: string, block: number, role: Role): string {
  const r = role === 'superMoow' ? 'SUPER (MOOW)' : role === 'superRover' ? 'SUPER (ROVER)' : POS_LABEL[role as Pos];
  return `${longDate(date)}${block >= 0 ? ' ' + BLOCKS[block] : ''} ${r}`;
}

export function solve(input: SolveInput): SolveResult {
  const rand = mulberry32(input.seed);
  const dates = [...new Set(input.dates)].sort();
  const solving = new Set(dates);
  const st = new State(input.people, input.appointments, input.bills);
  const warnings: string[] = [];

  // Fixed history: everything outside the dates being solved.
  for (const [date, bill] of Object.entries(input.bills)) {
    if (solving.has(date)) continue;
    const put = (block: number, role: Role, cell: Cell) => {
      if (!cell.personId) return;
      const a = makeAsg(date, block, role, cell.personId);
      a.locked = true;
      a.double = !!cell.double;
      st.add(a);
    };
    bill.blocks.forEach((row, b) => POSITIONS.forEach((pos) => put(b, pos, row[pos])));
    put(-1, 'superMoow', bill.superMoow);
    put(-1, 'superRover', bill.superRover);
  }

  const active = input.people.filter((p) => p.active);
  const watchable = active.filter((p) => p.elig.moow || p.elig.rover);
  if (watchable.length < 9) {
    warnings.push(
      `Only ${watchable.length} people can stand watch. At least 9 are needed for everyone to get 12 hours of rest, so some watches below break that rule.`,
    );
  }

  const placed = new Map<string, Asg>(); // "date|block|role"
  const key = (date: string, block: number, role: Role) => `${date}|${block}|${role}`;

  // Double watches are placed first and never moved.
  for (const d of input.doubles) {
    if (!solving.has(d.date)) continue;
    const p = st.people.get(d.personId);
    const order: Pos[] = p?.elig.rover || !p?.elig.moow ? ['rover1', 'rover2', 'moow'] : ['moow', 'rover1', 'rover2'];
    const pos = order.find((r) => !placed.has(key(d.date, d.block, r)));
    if (!pos) {
      warnings.push(`Double watch for ${nameOf(input.people, d.personId)} on ${where(d.date, d.block, 'moow')} could not fit: that watch is already full of double watches.`);
      continue;
    }
    const a = makeAsg(d.date, d.block, pos, d.personId);
    a.locked = true;
    a.double = true;
    if (!st.canTake(d.personId, a, { ...STRICT, minGap: 2, elig: true })) {
      a.forced = 'double watch clashes with another watch';
      warnings.push(`Double watch for ${nameOf(input.people, d.personId)} on ${where(d.date, d.block, pos)} is closer than 6 hours to another watch or super duty.`);
    }
    st.add(a);
    placed.set(key(d.date, d.block, pos), a);
  }

  // Constructive pass, in time order.
  const movable: Asg[] = [];
  const fill = (date: string, block: number, role: Role) => {
    if (placed.has(key(date, block, role))) return;
    const shape = makeAsg(date, block, role, '');
    // Stability: whoever had this watch before keeps it if that's still valid.
    const before = cellOf(input.bills[date], shape);
    if (before?.personId && !before.double && st.canTake(before.personId, shape)) {
      const a = { ...shape, pid: before.personId };
      st.add(a);
      placed.set(key(date, block, role), a);
      movable.push(a);
      return;
    }
    for (const level of LEVELS) {
      let best: string | null = null;
      let bestCost = Infinity;
      for (const p of active) {
        if (!st.canTake(p.id, shape, level.relax)) continue;
        const before = st.cost(p.id);
        const a = { ...shape, pid: p.id };
        st.add(a);
        const c = st.cost(p.id) - before + rand() * 0.5;
        st.remove(a);
        if (c < bestCost) {
          bestCost = c;
          best = p.id;
        }
      }
      if (best) {
        const a = { ...shape, pid: best, forced: level.reason || undefined };
        st.add(a);
        placed.set(key(date, block, role), a);
        movable.push(a);
        return;
      }
    }
    warnings.push(`${where(date, block, role)} could not be filled: not enough people.`);
  };
  for (const date of dates) {
    for (const role of SUPERS) fill(date, -1, role);
    for (let b = 0; b < 4; b++) for (const pos of POSITIONS) fill(date, b, pos);
  }

  // Local search: random replace and swap moves, keep any that lower the total cost.
  const ids = active.map((p) => p.id);
  const iterations = movable.length ? 6000 + 500 * movable.length : 0;
  const clear = (a: Asg) => (a.forced = undefined);
  for (let i = 0; i < iterations && ids.length > 1; i++) {
    const a = movable[Math.floor(rand() * movable.length)];
    if (rand() < 0.5) {
      const q = ids[Math.floor(rand() * ids.length)];
      if (q === a.pid || !st.canTake(q, a)) continue;
      const p = a.pid;
      const before = st.cost(p) + st.cost(q);
      const forced = a.forced;
      st.remove(a);
      a.pid = q;
      clear(a);
      st.add(a);
      if (st.cost(p) + st.cost(q) >= before) {
        st.remove(a);
        a.pid = p;
        a.forced = forced;
        st.add(a);
      }
    } else {
      const b = movable[Math.floor(rand() * movable.length)];
      const p = a.pid;
      const q = b.pid;
      if (p === q || (a.block < 0) !== (b.block < 0)) continue;
      if (!st.canTake(q, a, STRICT, b) || !st.canTake(p, b, STRICT, a)) continue;
      const before = st.cost(p) + st.cost(q);
      const fa = a.forced;
      const fb = b.forced;
      st.remove(a);
      st.remove(b);
      a.pid = q;
      b.pid = p;
      clear(a);
      clear(b);
      st.add(a);
      st.add(b);
      if (st.cost(p) + st.cost(q) >= before) {
        st.remove(a);
        st.remove(b);
        a.pid = p;
        b.pid = q;
        a.forced = fa;
        b.forced = fb;
        st.add(a);
        st.add(b);
      }
    }
  }

  // Build output bills.
  const bills: Bills = {};
  for (const date of dates) bills[date] = emptyBill(date);
  for (const a of placed.values()) {
    const cell = cellOf(bills[a.date], a)!;
    cell.personId = a.pid;
    if (a.double) cell.double = true;
  }
  // Mark every cell that breaks a rule (both watches of a short-rest pair), checked against fixed days too.
  for (const v of violations({ ...input.bills, ...bills }, input.people, input.appointments)) {
    if (!solving.has(v.date) || !v.personId) continue;
    cellOf(bills[v.date], v)!.forced = v.rule;
    warnings.push(`${where(v.date, v.block, v.role)}: ${nameOf(input.people, v.personId)}, ${v.rule}.`);
  }

  let nextDay = 0;
  for (const p of active) {
    const days = st
      .list(p.id)
      .filter((a) => !a.double)
      .map((a) => a.dn)
      .sort((x, y) => x - y);
    for (let i = 1; i < days.length; i++) if (days[i] - days[i - 1] === 1 && solving.has(dateOfDn(st, p.id, days[i]))) nextDay++;
  }
  // 14 duties a day: with fewer than 28 people some back-to-back days can't be avoided, so only mention it when they could be.
  if (nextDay && watchable.length >= 28) warnings.push(`${nextDay} time(s) someone has duty on back-to-back days. Adding names spreads watches out.`);
  return { bills, warnings };
}

function dateOfDn(st: State, pid: string, dn: number): string {
  return st.list(pid).find((a) => a.dn === dn)?.date ?? '';
}

// ---------- checking finished bills ----------

export interface Violation {
  date: string;
  block: number;
  role: Role;
  personId: string | null;
  rule: string;
}

/** Every hard-rule break in a set of bills. */
export function violations(bills: Bills, people: Person[], appointments: Appointment[]): Violation[] {
  const st = new State(people, appointments, {});
  const all: Asg[] = [];
  const out: Violation[] = [];
  for (const bill of Object.values(bills)) {
    const put = (block: number, role: Role, cell: Cell) => {
      if (!cell.personId) {
        out.push({ date: bill.date, block, role, personId: null, rule: 'empty' });
        return;
      }
      const a = makeAsg(bill.date, block, role, cell.personId);
      a.double = !!cell.double;
      st.add(a);
      all.push(a);
    };
    bill.blocks.forEach((row, b) => POSITIONS.forEach((pos) => put(b, pos, row[pos])));
    put(-1, 'superMoow', bill.superMoow);
    put(-1, 'superRover', bill.superRover);
  }
  for (const a of all) {
    const p = st.people.get(a.pid);
    if (!p) continue;
    // Report the first rule that fails, checking from loosest to strictest.
    const checks: [Relax, string][] = [
      [{ ...STRICT, minGap: 1, elig: true, superDay: true }, 'during an appointment'],
      [{ ...STRICT, minGap: 1, elig: true }, 'conflicts with super duty'],
      [{ ...STRICT, minGap: 2, elig: true }, 'back-to-back or same watch'],
      [{ ...STRICT, elig: true }, 'under 12 hours of rest'],
      [STRICT, 'not qualified for this position'],
    ];
    const active = p.active;
    p.active = true;
    for (const [relax, rule] of checks) {
      if (!st.canTake(a.pid, a, relax)) {
        out.push({ date: a.date, block: a.block, role: a.role, personId: a.pid, rule });
        break;
      }
    }
    p.active = active;
  }
  return out;
}

/** People who could take a cell without breaking a hard rule (for manual swaps). */
export function replacements(
  bills: Bills,
  people: Person[],
  appointments: Appointment[],
  date: string,
  block: number,
  role: Role,
): Person[] {
  const bill = bills[date];
  const cell = cellOf(bill, { block, role });
  if (!bill || !cell) return [];
  return people.filter((p) => {
    if (!p.active || p.id === cell.personId) return false;
    const trial: Bills = { ...bills, [date]: structuredClone(bill) };
    cellOf(trial[date], { block, role })!.personId = p.id;
    return !violations(trial, people, appointments).some((v) => v.personId === p.id);
  });
}

/** Watch counts per person across bills (double watches counted separately). */
export function counts(bills: Bills): Map<string, { regular: number; doubles: number; supers: number; nights: number }> {
  const m = new Map<string, { regular: number; doubles: number; supers: number; nights: number }>();
  const get = (id: string) => {
    let c = m.get(id);
    if (!c) m.set(id, (c = { regular: 0, doubles: 0, supers: 0, nights: 0 }));
    return c;
  };
  for (const bill of Object.values(bills)) {
    bill.blocks.forEach((row, b) =>
      POSITIONS.forEach((pos) => {
        const cell = row[pos];
        if (!cell.personId) return;
        const c = get(cell.personId);
        if (cell.double) c.doubles++;
        else {
          c.regular++;
          if (b === 3) c.nights++;
        }
      }),
    );
    for (const cell of [bill.superMoow, bill.superRover]) if (cell.personId) get(cell.personId).supers++;
  }
  return m;
}
