// The size dial (D18, D48): how many orgs, and how many of each record type in every org.

export interface SizeSpec {
  orgs: number;
  assets: number;
  risks: number;
  controls: number;
  policies: number;
  incidents: number;
}

export const SIZE_FIELDS = ['orgs', 'assets', 'risks', 'controls', 'policies', 'incidents'] as const;

export type SizeName = 'tiny' | 'accuracy' | 'stress';

export const SIZES: Readonly<Record<SizeName, Readonly<SizeSpec>>> = {
  tiny: { orgs: 1, assets: 30, risks: 10, controls: 15, policies: 3, incidents: 10 },
  // D48: 2 orgs whose documents come to about 300 chunks in all through the full pipeline.
  accuracy: { orgs: 2, assets: 60, risks: 20, controls: 30, policies: 6, incidents: 30 },
  // D48: 20 orgs × (2,000 assets, 300 risks, 400 controls, 40 policies, 1,000 incidents).
  stress: { orgs: 20, assets: 2000, risks: 300, controls: 400, policies: 40, incidents: 1000 },
};

const CUSTOM_PREFIX = 'custom:';

/** A size name (`tiny`, `accuracy`, `stress`) or `custom:orgs=…,assets=…,risks=…,controls=…,policies=…,incidents=…`. */
export function parseSize(text: string): SizeSpec {
  const trimmed = text.trim();
  if (trimmed === 'tiny' || trimmed === 'accuracy' || trimmed === 'stress') return { ...SIZES[trimmed] };
  if (!trimmed.startsWith(CUSTOM_PREFIX)) {
    throw new Error(`unknown size "${text}": use tiny, accuracy, stress or custom:orgs=…,assets=…`);
  }
  const values = new Map<string, number>();
  for (const part of trimmed.slice(CUSTOM_PREFIX.length).split(',')) {
    const match = /^\s*([a-z]+)\s*=\s*(\d+)\s*$/.exec(part);
    if (!match) throw new Error(`custom size: "${part}" is not name=whole number`);
    const [, field, value] = match as unknown as [string, string, string];
    if (!(SIZE_FIELDS as readonly string[]).includes(field)) throw new Error(`custom size: unknown field "${field}"`);
    if (values.has(field)) throw new Error(`custom size: "${field}" is given twice`);
    values.set(field, Number(value));
  }
  const size = {} as SizeSpec;
  for (const field of SIZE_FIELDS) {
    const value = values.get(field);
    if (value === undefined) throw new Error(`custom size: "${field}" is missing`);
    size[field] = value;
  }
  if (size.orgs < 1) throw new Error('custom size: orgs must be at least 1');
  return size;
}
