// The answer key as `pnpm gen:data` writes it (`data/generated/<seed>-<size>/answer-key.json`; D18),
// checked before a question set is built from it (S8-003). Strict: unknown fields are refused.
// - The generator version, the seed, the size (every `SIZE_FIELDS` number) and the orgs.
// - Each org: its key (`ORG-01`), its name, its records by kind, each record its key (`AST-0001`)
//   plus exactly the fields of S1's create schema for its kind, and its links.
// - Every org key once; every record key once in its org; as many orgs as the size says and as many
//   records of each kind; every link's ends are records of its org, of the kinds `LINK_TYPES` gives
//   its type.
// The problems name the field and IDs only, never a name or a value from the file (D163, D164).
// Pure: no I/O.
import type { AnswerKey } from '@grc/generators';
import { LINK_TYPES, answerKeyKeySchema, createSchemas, type LinkType, type RecordKind } from '@grc/shared';
import { z } from 'zod';

/** A record's name as the answer key holds it: not empty, no spaces around it, no U+0000, no lone surrogate. */
const recordName = z
  .string()
  .min(1)
  .refine(
    (s) => s === s.trim() && !s.includes('\u0000') && s.isWellFormed(),
    'must have no spaces around it, no null character and no lone surrogate',
  );

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const sizeSchema = z.strictObject({
  orgs: count.min(1),
  assets: count,
  risks: count,
  controls: count,
  policies: count,
  incidents: count,
});

/** A record's own fields: its key and name plus S1's create fields for its kind. */
const recordFields = { key: answerKeyKeySchema, name: recordName };
const worldRecords = {
  asset: createSchemas.asset.extend(recordFields),
  risk: createSchemas.risk.extend(recordFields),
  control: createSchemas.control.extend(recordFields),
  policy: createSchemas.policy.extend(recordFields),
  incident: createSchemas.incident.extend(recordFields),
};

const LINK_TYPE_NAMES = LINK_TYPES.map((row) => row.type) as [LinkType, ...LinkType[]];

const linkSchema = z.strictObject({
  type: z.enum(LINK_TYPE_NAMES),
  fromKey: answerKeyKeySchema,
  toKey: answerKeyKeySchema,
});

const orgSchema = z.strictObject({
  key: answerKeyKeySchema,
  name: recordName,
  assets: z.array(worldRecords.asset),
  risks: z.array(worldRecords.risk),
  controls: z.array(worldRecords.control),
  policies: z.array(worldRecords.policy),
  incidents: z.array(worldRecords.incident),
  links: z.array(linkSchema),
});

/** Each kind's list in an org and the size field that counts it. */
const KIND_LISTS = [
  ['asset', 'assets'],
  ['risk', 'risks'],
  ['control', 'controls'],
  ['policy', 'policies'],
  ['incident', 'incidents'],
] as const satisfies readonly (readonly [RecordKind, string])[];

export const answerKeySchema = z
  .strictObject({
    generatorVersion: z.string().trim().min(1).max(32),
    seed: count,
    size: sizeSchema,
    orgs: z.array(orgSchema).min(1),
  })
  .superRefine((key, ctx) => {
    if (key.orgs.length !== key.size.orgs) {
      ctx.addIssue({ code: 'custom', path: ['orgs'], message: `the size says ${key.size.orgs} org(s)` });
    }
    const orgKeys = new Set<string>();
    key.orgs.forEach((org, o) => {
      if (orgKeys.has(org.key))
        ctx.addIssue({ code: 'custom', path: ['orgs', o, 'key'], message: 'org key used twice' });
      orgKeys.add(org.key);

      const kindOf = new Map<string, RecordKind>();
      for (const [kind, list] of KIND_LISTS) {
        if (org[list].length !== key.size[list]) {
          ctx.addIssue({ code: 'custom', path: ['orgs', o, list], message: `the size says ${key.size[list]}` });
        }
        org[list].forEach((record, r) => {
          if (kindOf.has(record.key)) {
            ctx.addIssue({ code: 'custom', path: ['orgs', o, list, r, 'key'], message: 'record key used twice' });
          }
          kindOf.set(record.key, kind);
        });
      }

      org.links.forEach((link, l) => {
        const row = LINK_TYPES.find((t) => t.type === link.type)!;
        const from = kindOf.get(link.fromKey);
        const to = kindOf.get(link.toKey);
        if (from === undefined) {
          ctx.addIssue({ code: 'custom', path: ['orgs', o, 'links', l, 'fromKey'], message: 'no record has this key' });
        } else if (from !== row.from) {
          ctx.addIssue({
            code: 'custom',
            path: ['orgs', o, 'links', l, 'fromKey'],
            message: `${link.type} links go from ${row.from} to ${row.to}`,
          });
        }
        if (to === undefined) {
          ctx.addIssue({ code: 'custom', path: ['orgs', o, 'links', l, 'toKey'], message: 'no record has this key' });
        } else if (to !== row.to) {
          ctx.addIssue({
            code: 'custom',
            path: ['orgs', o, 'links', l, 'toKey'],
            message: `${link.type} links go from ${row.from} to ${row.to}`,
          });
        }
      });
    });
  });

/** One problem with an answer key: the field (`orgs.0.links.3.toKey`) and what is wrong with it. */
export interface AnswerKeyProblem {
  field: string;
  message: string;
}

/** An answer key that isn't valid; `problems` names each field that's wrong. */
export class AnswerKeyError extends Error {
  constructor(readonly problems: readonly AnswerKeyProblem[]) {
    super(
      problems.length === 0
        ? 'the answer key is not valid'
        : `the answer key is not valid: ${problems[0]!.field}: ${problems[0]!.message}`,
    );
    this.name = 'AnswerKeyError';
  }
}

/** The path of a Zod issue as one field name: `orgs.0.links.3.toKey`, or `(the whole file)`. */
export function fieldOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(the whole file)' : path.map((part) => String(part)).join('.');
}

/** Checks a parsed `answer-key.json`; throws an `AnswerKeyError` naming each field that's wrong. */
export function parseAnswerKey(value: unknown): AnswerKey {
  const result = answerKeySchema.safeParse(value);
  if (!result.success) {
    throw new AnswerKeyError(
      result.error.issues.map((issue) => ({ field: fieldOf(issue.path), message: issue.message })),
    );
  }
  return result.data;
}
