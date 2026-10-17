// The dashboard's colours, the same ones the app's badges use (ValueBadge, RatingBadge,
// StatusBadge), so a bar on Home reads like the dot beside the value on every list.
import type { DocumentStatus } from '@grc/shared';
import { useSyncExternalStore } from 'react';

/** Severity, criticality and risk band, low to critical. */
export const LEVELS = ['critical', 'high', 'medium', 'low'] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_COLOR: Readonly<Record<Level, string>> = {
  critical: '#b42318',
  high: '#dd6b20',
  medium: '#d4a017',
  low: '#2f8a55',
};

/** The text colour for a count called out at its level (darker than the dot, for contrast). */
export const LEVEL_TEXT: Readonly<Record<Level, string>> = {
  critical: 'text-[#b42318]',
  high: 'text-[#9a3a0b]',
  medium: 'text-[#7a5a0c]',
  low: 'text-[#1f5c38]',
};

export const CONTROL_STATUS_COLOR = {
  implemented: '#2f8a55',
  planned: '#2b6cb0',
  not_implemented: '#b42318',
} as const;

export const DOCUMENT_STATUS_COLOR: Readonly<Record<DocumentStatus, string>> = {
  stored: '#2b6cb0',
  processing: '#d4a017',
  processed: '#2f8a55',
  failed: '#b42318',
  removed: '#8a969c',
};

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function reducedNow(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(REDUCED_MOTION).matches;
}

/** Whether the person asked for less motion, so the charts draw without animating. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reducedNow, () => false);
}
