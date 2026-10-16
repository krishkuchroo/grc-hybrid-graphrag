// How the chat panel (D27 #9) says things that aren't already in S6-001's plain words
// (@grc/shared CHAT_TEXT, CHAT_STEP_TEXT, GRAPH_FALLBACK_TEXT, SEARCH_MODE_TEXT): the empty state,
// record kinds and their pages, durations, counts and when a conversation was last used.
import type { SearchRecordKind } from '@grc/shared';
import {
  ClipboardCheck,
  Library,
  ListChecks,
  Paperclip,
  Server,
  ShieldAlert,
  ShieldCheck,
  Siren,
  FileText,
  type LucideIcon,
} from 'lucide-react';
import { formatDay } from '@/features/records/format';

export const EMPTY_TEXT =
  'Ask about your risks, controls, assets, policies, incidents and frameworks. Answers use only what you can see.';

export const RECORD_KIND_TEXT: Readonly<Record<SearchRecordKind, string>> = {
  asset: 'Asset',
  risk: 'Risk',
  control: 'Control',
  policy: 'Policy',
  incident: 'Incident',
  framework: 'Framework',
  requirement: 'Requirement',
  evidence: 'Evidence',
  audit_finding: 'Audit finding',
};

export const RECORD_KIND_ICON: Readonly<Record<SearchRecordKind, LucideIcon>> = {
  asset: Server,
  risk: ShieldAlert,
  control: ShieldCheck,
  policy: FileText,
  incident: Siren,
  framework: Library,
  requirement: ListChecks,
  evidence: Paperclip,
  audit_finding: ClipboardCheck,
};

/** Each kind's own page. Evidence has none: it is shown on its control's page. */
export const RECORD_PAGE = {
  asset: '/assets/$id',
  risk: '/risks/$id',
  control: '/controls/$id',
  policy: '/policies/$id',
  incident: '/incidents/$id',
  framework: '/frameworks/$id',
  requirement: '/requirements/$id',
  audit_finding: '/audit-findings/$id',
} as const;

export type PagedKind = keyof typeof RECORD_PAGE;

export function hasPage(kind: string): kind is PagedKind {
  return Object.hasOwn(RECORD_PAGE, kind);
}

/** `340` → `340 ms`, `2150` → `2.2 s`, `75000` → `1 min 15 s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, '') : Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** `1 record`, `3 passages`. */
export function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `Just now`, `5 min ago`, `3 h ago`, `Yesterday`, then the day. */
export function lastUsedText(value: string, now: number = Date.now()): string {
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return value;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return 'Yesterday';
  return formatDay(value);
}

const TIME = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' });

/** A message's time of day, or its day and time when it wasn't today. */
export function messageTime(value: string, now: Date = new Date()): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? TIME.format(at) : `${formatDay(value)}, ${TIME.format(at)}`;
}
