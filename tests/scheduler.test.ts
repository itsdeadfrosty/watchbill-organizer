import { describe, expect, it } from 'vitest';
import { solve, violations, counts, replacements, type SolveInput } from '../src/scheduler';
import { dateRange, dayNum } from '../src/dates';
import { POSITIONS, type Bills, type Person } from '../src/model';

// Made-up names only.
const FAKE = 'ALDER BIRCH CEDAR DOGWOOD ELM FIR GINKGO HAZEL IVY JUNIPER KAPOK LARCH MAPLE NUTMEG OAK PINE QUINCE ROWAN SPRUCE TEAK ULMUS VINE WILLOW XYLO YEW ZELKOVA ASPEN BALSA CYPRESS'.split(' ');

function roster(n: number): Person[] {
  return FAKE.slice(0, n).map((name, i) => ({
    id: `p${i}`,
    name: `${name}, A.`,
    room: String(100 + i),
    active: true,
    elig: { moow: true, rover: true, superMoow: true, superRover: true },
    pref: { pos: null, blocks: [], days: [] },
  }));
}

const DATES = dateRange('2026-11-02', '2026-11-08');

function base(n = 27, extra: Partial<SolveInput> = {}): SolveInput {
  return { dates: DATES, people: roster(n), appointments: [], doubles: [], bills: {}, seed: 42, ...extra };
}

/** Slots of each person's regular watches, sorted. */
function slots(bills: Bills): Map<string, { slot: number; double: boolean }[]> {
  const m = new Map<string, { slot: number; double: boolean }[]>();
  for (const bill of Object.values(bills))
    bill.blocks.forEach((row, b) =>
      POSITIONS.forEach((pos) => {
        const c = row[pos];
        if (!c.personId) return;
        if (!m.has(c.personId)) m.set(c.personId, []);
        m.get(c.personId)!.push({ slot: 4 * dayNum(bill.date) + b, double: !!c.double });
      }),
    );
  for (const l of m.values()) l.sort((a, b) => a.slot - b.slot);
  return m;
}

function minGap(bills: Bills): number {
  let g = Infinity;
  for (const l of slots(bills).values()) for (let i = 1; i < l.length; i++) g = Math.min(g, l[i].slot - l[i - 1].slot);
  return g;
}

describe('generate', () => {
  it('27 names over 7 days: every slot filled, 12 h rest, counts within 1', () => {
    const { bills } = solve(base());
    expect(Object.keys(bills)).toHaveLength(7);
    expect(violations(bills, roster(27), [])).toEqual([]);
    expect(minGap(bills)).toBeGreaterThanOrEqual(3);
    const c = [...counts(bills).values()].map((x) => x.regular);
    const all = roster(27).map((p) => counts(bills).get(p.id)?.regular ?? 0);
    expect(c.reduce((a, b) => a + b, 0)).toBe(84);
    expect(Math.max(...all) - Math.min(...all)).toBeLessThanOrEqual(1);
  });

  it('nobody goes from 1800-2400 to 0600-1200 the next duty day', () => {
    const { bills } = solve(base());
    for (let i = 1; i < DATES.length; i++) {
      const evening = POSITIONS.map((p) => bills[DATES[i - 1]].blocks[2][p].personId);
      const morning = POSITIONS.map((p) => bills[DATES[i]].blocks[0][p].personId);
      expect(evening.filter((id) => morning.includes(id))).toEqual([]);
    }
  });

  it('8 names warns about the 9-person minimum and flags every broken rule', () => {
    const people = roster(8);
    const { bills, warnings } = solve(base(8));
    expect(warnings[0]).toMatch(/At least 9/);
    const v = violations(bills, people, []);
    // Anything that breaks a rule is marked on the bill itself.
    for (const x of v) {
      const bill = bills[x.date];
      const cell = x.block < 0 ? (x.role === 'superMoow' ? bill.superMoow : bill.superRover) : bill.blocks[x.block][x.role as 'moow'];
      expect(cell.forced, `${x.date} ${x.block} ${x.role} ${x.rule}`).toBeTruthy();
    }
    // Still fully staffed.
    expect(v.filter((x) => x.rule === 'empty')).toEqual([]);
  });

  it('same inputs and seed give the same bill', () => {
    expect(solve(base()).bills).toEqual(solve(base()).bills);
  });

  it('a block-4 preference gets more nights than average', () => {
    const people = roster(27);
    people[5].pref.blocks = [3];
    const { bills } = solve(base(27, { people }));
    const c = counts(bills);
    const avg = [...c.values()].reduce((a, x) => a + x.nights, 0) / 27;
    expect(c.get('p5')!.nights).toBeGreaterThan(avg);
    expect(violations(bills, people, [])).toEqual([]);
  });

  it('respects eligibility toggles', () => {
    const people = roster(27);
    for (const p of people.slice(0, 10)) p.elig.moow = false;
    const { bills } = solve(base(27, { people }));
    for (const bill of Object.values(bills)) for (const row of bill.blocks) expect(Number(row.moow.personId!.slice(1))).toBeGreaterThanOrEqual(10);
  });
});

describe('appointments and re-solving', () => {
  function withAppointment(date: string) {
    const first = solve(base());
    const victim = first.bills[date].blocks[1].rover1.personId!;
    const appointments = [{ id: 'a1', personId: victim, date, blocks: [1], note: '' }];
    const redo = DATES.filter((d) => d >= date);
    const second = solve({ ...base(), appointments, dates: redo, bills: first.bills });
    const merged = { ...first.bills, ...second.bills };
    return { first, merged, victim, appointments };
  }

  it('removes the person, keeps the bill valid, and leaves earlier dates alone', () => {
    const { first, merged, victim, appointments } = withAppointment('2026-11-05');
    const row = merged['2026-11-05'].blocks[1];
    expect(POSITIONS.map((p) => row[p].personId)).not.toContain(victim);
    expect(violations(merged, roster(27), appointments)).toEqual([]);
    for (const d of DATES.filter((d) => d < '2026-11-05')) expect(merged[d]).toEqual(first.bills[d]);
  });

  it('works the same on the first (already past) date', () => {
    const { merged, victim, appointments } = withAppointment('2026-11-02');
    expect(POSITIONS.map((p) => merged['2026-11-02'].blocks[1][p].personId)).not.toContain(victim);
    expect(violations(merged, roster(27), appointments)).toEqual([]);
  });

  it('re-solving keeps most of the old bill', () => {
    const { first, merged } = withAppointment('2026-11-05');
    let same = 0;
    let total = 0;
    for (const d of DATES.filter((d) => d >= '2026-11-05'))
      for (let b = 0; b < 4; b++)
        for (const p of POSITIONS) {
          total++;
          if (first.bills[d].blocks[b][p].personId === merged[d].blocks[b][p].personId) same++;
        }
    expect(same / total).toBeGreaterThan(0.85);
  });
});

describe('double watches', () => {
  it('gives exactly one 6 h gap, flagged, and normal generation never does', () => {
    const first = solve(base());
    expect(minGap(first.bills)).toBeGreaterThanOrEqual(3);
    // Find someone on 0600-1200 and give them a double at 1800-2400 the same day.
    const date = '2026-11-04';
    const pid = first.bills[date].blocks[0].moow.personId!;
    const doubles = [{ id: 'd1', personId: pid, date, block: 2, note: '' }];
    const second = solve({ ...base(), doubles, dates: DATES.filter((d) => d >= date), bills: first.bills });
    const merged = { ...first.bills, ...second.bills };
    expect(violations(merged, roster(27), [])).toEqual([]);
    const mine = slots(merged).get(pid)!;
    const gaps = mine.slice(1).map((s, i) => s.slot - mine[i].slot);
    expect(gaps.filter((g) => g === 2)).toHaveLength(1);
    expect(mine.filter((s) => s.double)).toHaveLength(1);
    // Everybody else still has 12 h rest.
    for (const [id, l] of slots(merged)) if (id !== pid) for (let i = 1; i < l.length; i++) expect(l[i].slot - l[i - 1].slot).toBeGreaterThanOrEqual(3);
  });
});

describe('manual swap', () => {
  it('only offers people who keep every rule', () => {
    const people = roster(27);
    const { bills } = solve(base());
    const options = replacements(bills, people, [], '2026-11-04', 2, 'rover2');
    expect(options.length).toBeGreaterThan(0);
    for (const p of options) {
      const trial = structuredClone(bills);
      trial['2026-11-04'].blocks[2].rover2.personId = p.id;
      expect(violations(trial, people, [])).toEqual([]);
    }
  });
});
