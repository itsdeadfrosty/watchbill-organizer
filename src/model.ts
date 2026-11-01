export const BLOCKS = ['0600-1200', '1200-1800', '1800-2400', '2400-0600'] as const;
export const POSITIONS = ['moow', 'rover1', 'rover2'] as const;
export type Pos = (typeof POSITIONS)[number];
export const POS_LABEL: Record<Pos, string> = { moow: 'MOOW', rover1: 'ROVER 1', rover2: 'ROVER 2' };

export interface Eligibility {
  moow: boolean;
  rover: boolean;
  superMoow: boolean;
  superRover: boolean;
}

export interface Preferences {
  pos: 'moow' | 'rover' | null;
  /** Block indexes 0-3. Empty = no preference. */
  blocks: number[];
  /** Weekdays 0-6 (0 = Sunday). Empty = no preference. */
  days: number[];
}

export interface Person {
  id: string;
  name: string;
  room: string;
  active: boolean;
  elig: Eligibility;
  pref: Preferences;
}

export interface Appointment {
  id: string;
  personId: string;
  date: string;
  blocks: number[];
  note: string;
}

export interface DoubleWatch {
  id: string;
  personId: string;
  date: string;
  block: number;
  note: string;
}

export interface Cell {
  personId: string | null;
  double?: boolean;
  /** Filled by breaking a rule because nothing valid was left. */
  forced?: string;
}

export interface DayBill {
  date: string;
  /** blocks[block][pos] */
  blocks: Record<Pos, Cell>[];
  superMoow: Cell;
  superRover: Cell;
}

export type Bills = Record<string, DayBill>;

export interface Revision {
  id: string;
  at: string;
  reason: string;
  dates: string[];
  bills: Bills;
  /** Dates in this revision that had already been printed before the change. */
  changedAfterPrint: string[];
}

export interface Contact {
  label: string;
  phone: string;
}

export interface Settings {
  section: string;
  sectionLead: Contact;
  deckLeads: Contact[];
  coordinator: string;
}

export interface Profile {
  schema: 1;
  seed: number;
  people: Person[];
  appointments: Appointment[];
  doubles: DoubleWatch[];
  settings: Settings;
  bills: Bills;
  history: Revision[];
  /** date -> ISO time it was last printed */
  printed: Record<string, string>;
  /** Preferences changed after the bills were last built. */
  prefsChanged?: boolean;
}

export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function newPerson(name: string, room = ''): Person {
  return {
    id: newId(),
    name,
    room,
    active: true,
    elig: { moow: true, rover: true, superMoow: true, superRover: true },
    pref: { pos: null, blocks: [], days: [] },
  };
}

export function emptyProfile(): Profile {
  return {
    schema: 1,
    seed: crypto.getRandomValues(new Uint32Array(1))[0],
    people: [],
    appointments: [],
    doubles: [],
    settings: {
      section: '',
      sectionLead: { label: '', phone: '' },
      deckLeads: [
        { label: '', phone: '' },
        { label: '', phone: '' },
      ],
      coordinator: '',
    },
    bills: {},
    history: [],
    printed: {},
  };
}

/** Fill in anything an older saved profile is missing. */
export function migrate(p: Profile): Profile {
  const fresh = emptyProfile();
  p.settings = { ...fresh.settings, ...p.settings };
  p.printed ??= {};
  for (const x of p.people) x.elig = { moow: true, rover: true, superMoow: true, superRover: true };
  return p;
}

export function emptyBill(date: string): DayBill {
  const cell = (): Cell => ({ personId: null });
  return {
    date,
    blocks: BLOCKS.map(() => ({ moow: cell(), rover1: cell(), rover2: cell() })),
    superMoow: cell(),
    superRover: cell(),
  };
}
