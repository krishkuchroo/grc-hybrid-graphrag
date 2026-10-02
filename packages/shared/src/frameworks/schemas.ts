// The Framework and Requirement schemas (D30, D51, D67, D68, D69, D73): the record as the API
// returns it, with `label` for `sensitivity`, and the catalog-file shapes the loader reads. All of
// them refuse unknown fields, and a code must match its own framework's pattern.
import { z } from 'zod';
import { LABELS } from '../access/labels.js';
import { RECORD_ORIGINS, RECORD_STATUSES } from '../records/types.js';
import { isRequirementCode } from './codes.js';
import { FRAMEWORK_KEYS } from './frameworks.js';
import { CATALOG_NUMBER_PREFIX } from './numbers.js';

const frameworkKey = z.enum(FRAMEWORK_KEYS);
const text = z.string().regex(/\S/, 'must not be blank');
const userId = z.string().min(1);

/** The fields every record has (as S1's records), with the catalog kind's own number prefix. */
function commonFields(prefix: string) {
  return {
    id: z.uuid(),
    number: z.string().regex(new RegExp(`^${prefix}\\d{7}$`)),
    sourceIds: z.array(z.string()),
    name: z.string(),
    label: z.enum(LABELS),
    status: z.enum(RECORD_STATUSES),
    owner: userId,
    version: z.int().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    createdBy: userId,
    updatedAt: z.iso.datetime({ offset: true }),
    updatedBy: userId,
    origin: z.enum(RECORD_ORIGINS),
  };
}

function codeMatchesFramework(value: { framework: string; code: string }, ctx: z.RefinementCtx): void {
  if (!isRequirementCode(value.framework, value.code)) {
    ctx.addIssue({ code: 'custom', path: ['code'], message: "must be a code of the requirement's framework" });
  }
}

export const frameworkSchema = z.strictObject({
  ...commonFields(CATALOG_NUMBER_PREFIX.framework),
  key: frameworkKey,
  frameworkVersion: text,
  publisher: text,
  description: text,
});

export const requirementSchema = z
  .strictObject({
    ...commonFields(CATALOG_NUMBER_PREFIX.requirement),
    code: z.string(),
    title: text,
    description: text,
    framework: frameworkKey,
    group: text,
    parentCode: z.string().nullable(),
    sortKey: text,
  })
  .superRefine(codeMatchesFramework);

/** One requirement as it sits in a catalog file (the file names its framework). */
export const catalogRequirementSchema = z.strictObject({
  code: text,
  title: text,
  description: text,
  group: text,
});

const catalogMappingEnd = z
  .strictObject({ framework: frameworkKey, code: z.string() })
  .superRefine(codeMatchesFramework);

/** One NIST-authored mapping in a catalog file: the citing requirement to the cited one (D212 (1)). */
export const catalogMappingSchema = z.strictObject({ from: catalogMappingEnd, to: catalogMappingEnd });

export type FrameworkRecord = z.infer<typeof frameworkSchema>;
export type RequirementRecord = z.infer<typeof requirementSchema>;
export type CatalogRequirement = z.infer<typeof catalogRequirementSchema>;
export type CatalogMapping = z.infer<typeof catalogMappingSchema>;
