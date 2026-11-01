// Dates are plain 'YYYY-MM-DD' strings for the duty day (the 0600 start).

const DAY_MS = 86400000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function dayNum(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNum(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromDayNum(dayNum(date) + days);
}

/** 0 = Sunday. */
export function weekday(date: string): number {
  return (((dayNum(date) + 4) % 7) + 7) % 7;
}

export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let n = dayNum(start); n <= dayNum(end); n++) out.push(fromDayNum(n));
  return out;
}

export function today(): string {
  const t = new Date();
  return fromDayNum(Math.round(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / DAY_MS));
}

/** "01 NOV 26" */
export function militaryDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
}

/** "SAT 01 NOV 26" */
export function longDate(date: string): string {
  return `${WEEKDAYS[weekday(date)]} ${militaryDate(date)}`;
}
