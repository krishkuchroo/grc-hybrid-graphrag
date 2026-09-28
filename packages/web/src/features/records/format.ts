// How record values read on screen. Stored values are lowercase with `_` between words (D197);
// the web shows the plain words.

/** `not_implemented` → `Not implemented`. */
export function words(value: string): string {
  const text = value.replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
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

export function formatMoment(value: string): string {
  const date = parse(value);
  return date ? MOMENT.format(date) : value;
}

export function formatDollars(value: number): string {
  return DOLLARS.format(value);
}
