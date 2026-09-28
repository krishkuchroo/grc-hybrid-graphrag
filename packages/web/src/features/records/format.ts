// How record values read on screen. Stored values are lowercase with `_` between words (D197);
// the web shows the plain words.

/** `not_implemented` → `Not implemented`. */
export function words(value: string): string {
  const text = value.replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
const DATE_UTC = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const MOMENT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function parse(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDay(value: string): string {
  const date = parse(value);
  return date ? DAY.format(date) : value;
}

/** A stored day (`2026-06-30`), shown as that day wherever the browser is: never shifted by the time zone. */
export function formatDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDay(value);
  const date = parse(`${value}T00:00:00.000Z`);
  return date ? DATE_UTC.format(date) : value;
}

/** A value list as choices: the stored value and its words. */
export function choices(values: readonly string[]): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: words(value) }));
}

export function formatMoment(value: string): string {
  const date = parse(value);
  return date ? MOMENT.format(date) : value;
}

export function formatDollars(value: number): string {
  return DOLLARS.format(value);
}
