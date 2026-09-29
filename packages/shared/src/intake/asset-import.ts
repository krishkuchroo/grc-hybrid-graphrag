// Asset list import: our fields, column-name suggestions and the saved mapping (D40, D44, D30).
import { z } from 'zod';

export const ASSET_IMPORT_FIELDS = [
  'sourceId',
  'name',
  'assetType',
  'criticality',
  'dataClassification',
  'owner',
  'hostedOn',
  'runsOn',
] as const;
export type AssetImportField = (typeof ASSET_IMPORT_FIELDS)[number];

export const REQUIRED_IMPORT_FIELDS = ['sourceId', 'name'] as const;

/** Lowercase; spaces, dashes and dots become `_`; trimmed. */
export function normaliseHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_');
}

/** Trim, lowercase; spaces and dashes become `_` (the D197 stored spelling). */
export function normaliseValue(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Column names (after `normaliseHeader`) that obviously mean each field. The lists never overlap. */
const SYNONYMS: Readonly<Record<AssetImportField, readonly string[]>> = {
  sourceId: ['id', 'sys_id', 'asset_id', 'assetid', 'ci_id'],
  name: ['name', 'hostname', 'asset_name', 'display_name'],
  assetType: ['type', 'asset_type', 'class', 'sys_class_name', 'category'],
  criticality: ['criticality', 'tier', 'business_criticality', 'u_criticality'],
  dataClassification: ['data_classification', 'classification', 'sensitivity'],
  owner: ['owner', 'owner_email', 'managed_by', 'assigned_to'],
  hostedOn: ['hosted_on', 'host', 'parent', 'runs_on_host'],
  runsOn: ['runs_on', 'platform', 'depends_on'],
};

/**
 * Pre-fills a field when exactly one header matches its synonyms, answering with the header as given.
 * A header fills one field at most; two candidates for one field leave it empty (no guessing).
 */
export function suggestMapping(headers: readonly string[]): Partial<Record<AssetImportField, string>> {
  const mapping: Partial<Record<AssetImportField, string>> = {};
  const used = new Set<number>();
  for (const field of ASSET_IMPORT_FIELDS) {
    const candidates: number[] = [];
    headers.forEach((h, i) => {
      if (SYNONYMS[field].includes(normaliseHeader(h))) candidates.push(i);
    });
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only !== undefined && !used.has(only)) {
      used.add(only);
      mapping[field] = headers[only];
    }
  }
  return mapping;
}

/** A source name: 1-100 letters, digits, spaces, `_`, `-` and `.`. */
export const sourceNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9 _.-]+$/);

const column = z.string().min(1);

export const importMappingSchema = z.strictObject({
  source: sourceNameSchema,
  fields: z
    .strictObject({
      sourceId: column,
      name: column,
      assetType: column.optional(),
      criticality: column.optional(),
      dataClassification: column.optional(),
      owner: column.optional(),
      hostedOn: column.optional(),
      runsOn: column.optional(),
    })
    .refine((fields) => {
      const columns = Object.values(fields).filter((c) => c !== undefined);
      return new Set(columns).size === columns.length;
    }, 'a column may fill one field only'),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;
