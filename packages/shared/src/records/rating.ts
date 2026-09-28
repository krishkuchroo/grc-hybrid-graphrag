// The 5x5 risk rating (D197): score = impact x likelihood, banded low, medium, high or critical.
import { RISK_SCALE } from './values.js';

export type RiskBand = 'low' | 'medium' | 'high' | 'critical';

function onScale(value: number): boolean {
  return (RISK_SCALE as readonly number[]).includes(value);
}

export function riskRating(impact: number, likelihood: number): { score: number; band: RiskBand } {
  if (!onScale(impact) || !onScale(likelihood)) throw new Error('impact and likelihood must be 1 to 5');
  const score = impact * likelihood;
  const band: RiskBand = score <= 4 ? 'low' : score <= 9 ? 'medium' : score <= 16 ? 'high' : 'critical';
  return { score, band };
}
