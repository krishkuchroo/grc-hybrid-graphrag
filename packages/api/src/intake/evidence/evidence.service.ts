// Evidence (S3-009, D202, D213 (1)-(3)): a file that shows a control works, attached to that control
// (SUPPORTS, D67), with its dates, label and review status.
// - Who (D50, D213 (3)): the Admin adds evidence to any control they can see and changes any
//   evidence; a Control Owner adds evidence only to controls they own, sees every item on their own
//   controls whoever added it, and changes only what they added; Risk Managers, Compliance
//   Managers, Auditors and Analysts view; the Viewer sees none. Labels apply on top (D51). The
//   shared `canAddEvidence`, `canSeeEvidence` and `canEditEvidence` are the rules.
// - Our code checks first (D45.3, D59). Reads then run as the caller's read-only role x clearance
//   account (readAs), so Neo4j checks again; the Control Owner's accounts have no MATCH on Evidence
//   or Control, so their reads run as the writer with the owner and label conditions in the query.
// - Adding (D37, D45.4): the rules pass first, only then is the file stored through `storeUpload`
//   (kind `evidence`, under the intake system context, R12), and then one Neo4j transaction creates
//   the node and its SUPPORTS link with one `record.created` entry. A failure there keeps neither;
//   the document row may stay, and a retry reuses it.
// - Evidence document rows are written and read only under the intake system context (R12), after
//   the evidence rules have passed and the evidence was found by the graph query.
// - Stale saves are refused (D69), evidence is retired, never deleted, and numbers come from the
//   per-org `evidence` counter (D68, D213 (1)). The review fields are set only at creation here.
// - Log lines about a failed write hold only the error's type and code and the IDs (D163, D164);
//   audit entries hold fields and IDs, never file contents or file names.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  EVIDENCE_VALIDITIES,
  FORMAT_CONTENT_TYPES,
  LABELS,
  ROLE_TABLE,
  can,
  canAddEvidence,
  canChangeLabel,
  canEditEvidence,
  canSeeEvidence,
  defaultLabel,
  evidenceDateMessage,
  evidenceDateProblems,
  evidenceRecordSchema,
  evidenceValidity,
  intakeCreateSchemasOn,
  intakeUpdateSchemasOn,
  isVisible,
  type EvidenceRecord,
  type FileFormat,
  type Label,
} from '@grc/shared';
import type { AuditService } from '../../audit/audit.service.js';
import type { AuditActor, AuditOutbox, OutboxAudit } from '../../audit/outbox.js';
import { ApiError, errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Paged } from '../../common/paging.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { member, user } from '../../identity/schema.js';
import { isOrgMember } from '../../records/owners.js';
import { NUMBER_CLASH_ATTEMPTS, isNumberClash } from '../../records/record-numbers.js';
import type { Caller } from '../../records/records.service.js';
import type { FileStore } from '../../storage/file-store.js';
import { utcToday } from '../audit-findings/finding-queries.js';
import { DocumentFileUnreadable, attachmentDisposition } from '../documents/documents.service.js';
import { documents } from '../intake.schema.js';
import { INTAKE_SYSTEM_CONTEXT } from '../queues.js';
import type { MultipartForm } from '../uploads/multipart.js';
import { cleanFileName, sha256Hex, storageKeyFor, storeUpload } from '../uploads/store-upload.js';
import { takeEvidenceNumber } from './evidence-numbers.js';
import {
  attachedCountQuery,
  controlEvidenceQuery,
  controlForWriteQuery,
  controlGetQuery,
  createEvidenceQuery,
  evidenceForWriteQuery,
  evidenceGetQuery,
  evidenceListQueries,
  isRecordId,
  lockControlQuery,
  lockEvidenceQuery,
  parseControlEvidenceQuery,
  parseEvidenceListQuery,
  recordIdSchema,
  saveEvidenceQuery,
  type BuiltQuery,
  type EvidenceScope,
} from './evidence-queries.js';

/** Neo4j stops an evidence read after this long (D48). */
export const EVIDENCE_READ_TIMEOUT_MS = 5000;

/** A control an evidence item supports, as the API returns it. */
export const evidenceControlSchema = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  label: z.enum(LABELS),
  status: z.string(),
});

/** Evidence as the API returns it: the record, the controls it supports that the caller can see,
 * its validity today, the reviewer's name, and whether the caller may change it. */
export const evidenceOutSchema = evidenceRecordSchema.extend({
  controls: z.array(evidenceControlSchema),
  validity: z.enum(EVIDENCE_VALIDITIES),
  reviewer: z.object({ id: z.string(), name: z.string() }).nullable(),
  canEdit: z.boolean(),
});

export type EvidenceOut = z.infer<typeof evidenceOutSchema>;

export const pagedEvidenceSchema = z.object({
  items: z.array(evidenceOutSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});

export const evidenceListSchema = z.object({ items: z.array(evidenceOutSchema) });

/** The text fields of `POST /api/v1/evidence`'s form, for the OpenAPI document. The service checks
 * them with S3-002's create schema (with today's date) plus the control's ID. */
export const evidenceFormFieldsSchema = z.object({
  controlId: z.string().describe('The control this evidence supports (its ID)'),
  name: z.string().describe('What the evidence is'),
  collectedDate: z.string().describe('The date it was collected, YYYY-MM-DD, not after today'),
  validUntil: z.string().optional().describe('The last day it is valid, YYYY-MM-DD, on or after collectedDate'),
  label: z.enum(LABELS).optional().describe('The sensitivity label, confidential when not given; never above yours'),
  owner: z.string().optional().describe('The owner (a member of the org), you when not given'),
});

/** The body of `POST /api/v1/evidence/:id/retire`. */
export const retireEvidenceBodySchema = z.strictObject({ version: z.int().min(1) });

/** What a download sends: the stored bytes and the headers that go with them. */
export interface EvidenceFile {
  body: Buffer;
  contentType: string;
  disposition: string;
}

export interface EvidenceServiceDeps {
  graph: Pick<GraphService, 'read' | 'readAs'>;
  outbox: Pick<AuditOutbox, 'withAuditedWrite'>;
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  files: Pick<FileStore, 'put' | 'exists' | 'get'>;
  log?: Logger;
  /** Today's date as `YYYY-MM-DD`, for the date rules and `validity` (UTC by default). */
  today?: () => string;
}

/** A control as stored, as far as the evidence rules need it. */
interface StoredControl {
  id: string;
  number: string;
  name: string;
  label: Label;
  owner: string;
  status: string;
}

/** An evidence node's properties and the controls it supports (as the query let through). */
interface Found {
  p: Record<string, unknown>;
  controls: StoredControl[];
}

const STALE_MESSAGE = 'This record changed since you opened it. Reload it and try again.';
const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', 'The record was not found.');
const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not do this.');
const LABEL_FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not set this label.');
const BAD_OWNER = (): ApiError =>
  new ApiError(400, 'validation_failed', 'owner: must be a member of this organization.');
const EVIDENCE_EXISTS = (): ApiError =>
  new ApiError(409, 'evidence_exists', 'This file is already attached to this control as evidence.');

const controlIdFieldSchema = z.object({ controlId: recordIdSchema });

/** The form's text fields, trimmed, with empty ones dropped (a browser form sends every field). */
function formValues(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields)
      .map(([name, value]) => [name, value.trim()] as const)
      .filter(([, value]) => value !== ''),
  );
}

/** Integers go to Neo4j as integers, not floats. */
function toNeo(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, typeof v === 'number' && Number.isInteger(v) ? neo4j.int(v) : v]),
  );
}

function toStoredControl(c: Record<string, unknown>): StoredControl {
  return {
    id: c['id'] as string,
    number: c['number'] as string,
    name: (c['name'] as string | undefined) ?? '',
    label: c['sensitivity'] as Label,
    owner: c['owner'] as string,
    status: (c['status'] as string | undefined) ?? 'active',
  };
}

function controlsOf(value: unknown): StoredControl[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null).map(toStoredControl);
}

/** A stored evidence node as the record schema has it (the label as `label`; missing optional
 * values as `null`). */
function toRecord(p: Record<string, unknown>): EvidenceRecord {
  return {
    id: p['id'] as string,
    number: p['number'] as string,
    sourceIds: (p['sourceIds'] as string[] | undefined) ?? [],
    name: p['name'] as string,
    label: p['sensitivity'] as Label,
    status: p['status'] as EvidenceRecord['status'],
    owner: p['owner'] as string,
    version: Number(p['version']),
    createdAt: p['createdAt'] as string,
    createdBy: p['createdBy'] as string,
    updatedAt: p['updatedAt'] as string,
    updatedBy: p['updatedBy'] as string,
    origin: p['origin'] as EvidenceRecord['origin'],
    collectedDate: p['collectedDate'] as string,
    validUntil: (p['validUntil'] as string | undefined) ?? null,
    fileKey: p['fileKey'] as string,
    fileHash: p['fileHash'] as string,
    documentId: p['documentId'] as string,
    fileName: p['fileName'] as string,
    format: p['format'] as FileFormat,
    sizeBytes: Number(p['sizeBytes']),
    reviewStatus: (p['reviewStatus'] as EvidenceRecord['reviewStatus'] | undefined) ?? 'pending',
    reviewedBy: (p['reviewedBy'] as string | undefined) ?? null,
    reviewedAt: (p['reviewedAt'] as string | undefined) ?? null,
  };
}

/** Our code's own check of a control (D50, D51), with ownership for the "own" cell. */
function controlVisibleTo(caller: Caller, c: StoredControl): boolean {
  return (
    isVisible(caller.clearance, c.label) && can(caller.role, 'control', 'view', { isOwner: c.owner === caller.userId })
  );
}

/** The owners of the controls whose labels the caller can see: what `canSeeEvidence` and
 * `canEditEvidence` take (a Control Owner sees evidence on a visible control they own). */
function visibleOwners(caller: Caller, controls: readonly StoredControl[]): string[] {
  return controls.filter((c) => isVisible(caller.clearance, c.label)).map((c) => c.owner);
}

/** Our code's own check of an evidence item (D50, D51, D213 (3)). */
function evidenceVisibleTo(caller: Caller, found: Found): boolean {
  return canSeeEvidence(caller, { label: String(found.p['sensitivity']) }, visibleOwners(caller, found.controls));
}

function evidenceEditableBy(caller: Caller, found: Found): boolean {
  const evidence = { label: String(found.p['sensitivity']), createdBy: String(found.p['createdBy']) };
  return canEditEvidence(caller, evidence, visibleOwners(caller, found.controls));
}

/** The API's name for a stored property (`sensitivity` is `label`). */
function apiName(prop: string): string {
  return prop === 'sensitivity' ? 'label' : prop;
}

function higher(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
}

/** An error without the failed write's details, for the caller (the log has the IDs). */
class EvidenceWriteFailed extends Error {
  constructor(readonly code: string | undefined) {
    super('The evidence could not be saved.');
    this.name = 'EvidenceWriteFailed';
  }
}

async function run(tx: ManagedTransaction, q: BuiltQuery) {
  return tx.run(q.text, q.params);
}

async function props(tx: ManagedTransaction, q: BuiltQuery): Promise<Record<string, unknown>[]> {
  const res = await run(tx, q);
  return res.records.map((r) => r.get('p') as Record<string, unknown>);
}

async function found(tx: ManagedTransaction, q: BuiltQuery): Promise<Found[]> {
  const res = await run(tx, q);
  return res.records.map((r) => ({
    p: r.get('p') as Record<string, unknown>,
    controls: controlsOf(r.get('controls')),
  }));
}

function actorOf(caller: Caller): AuditActor {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

export class EvidenceService {
  private readonly graph: EvidenceServiceDeps['graph'];
  private readonly outbox: EvidenceServiceDeps['outbox'];
  private readonly db: Db;
  private readonly audit: EvidenceServiceDeps['audit'];
  private readonly files: EvidenceServiceDeps['files'];
  private readonly log: Logger;
  private readonly today: () => string;

  constructor(deps: EvidenceServiceDeps) {
    this.graph = deps.graph;
    this.outbox = deps.outbox;
    this.db = deps.db;
    this.audit = deps.audit;
    this.files = deps.files;
    this.log = (deps.log ?? createLogger()).child({ context: 'EvidenceService' });
    this.today = deps.today ?? (() => utcToday());
  }

  /**
   * Adds evidence to a control. The checks run in this order: the form's fields (400), the file
   * (400), the role (403), the label (403, D198), the owner (400), the control visible (404),
   * `canAddEvidence` (403), the same file not on the control yet (409 `evidence_exists`); then the
   * file is stored (`storeUpload`'s own checks: 400, 413, 415), and the node, its SUPPORTS link
   * and one `record.created` entry are saved in one transaction, where the checks run again.
   */
  async create(caller: Caller, form: MultipartForm): Promise<EvidenceOut> {
    const today = this.today();
    const { controlId: givenControlId, ...rest } = formValues(form.fields);
    const { controlId } = controlIdFieldSchema.parse({ controlId: givenControlId });
    const body = intakeCreateSchemasOn(today).evidence.parse(rest);
    const file = form.file;
    if (!file) throw new ApiError(400, 'validation_failed', 'file: attach one file.');
    const cell = ROLE_TABLE.evidence[caller.role];
    if (cell !== 'edit' && cell !== 'upload_own') throw FORBIDDEN();
    const label = body.label ?? defaultLabel('evidence');
    if (!isVisible(caller.clearance, label)) throw LABEL_FORBIDDEN(); // D198
    if (body.owner === undefined && caller.apiKeyId !== undefined) {
      throw new ApiError(400, 'validation_failed', 'owner: an API key must name an owner.');
    }
    if (body.owner !== undefined && !(await isOrgMember(this.db, caller, body.owner))) throw BAD_OWNER();
    const owner = body.owner ?? caller.userId;

    const control = await this.findControlForAdd(caller, controlId);
    if (!control) throw NOT_FOUND();
    if (!canAddEvidence(caller, control)) throw FORBIDDEN();
    const fileHash = sha256Hex(file.body);
    const attached = await this.graph.read(caller.orgId, async (tx) => {
      const res = await run(tx, attachedCountQuery(controlId, fileHash));
      return Number(res.records[0]?.get('n') ?? 0) > 0;
    });
    if (attached) throw EVIDENCE_EXISTS();

    // The rules passed: only now is the file stored, under the intake system context (R12).
    const stored = await storeUpload(
      { db: this.db, audit: this.audit, files: this.files, log: this.log },
      caller,
      { kind: 'evidence', fileName: file.fileName, body: file.body, label },
      { context: 'system' },
    );
    const document = stored.document;
    const fileFields = {
      fileKey: storageKeyFor(document.contentHash),
      fileHash: document.contentHash,
      documentId: document.id,
      fileName: cleanFileName(file.fileName) ?? document.fileName,
      format: document.format,
      sizeBytes: file.body.length,
    };
    const fields: Record<string, unknown> = {
      name: body.name,
      collectedDate: body.collectedDate,
      validUntil: body.validUntil ?? null,
    };
    const storedFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));

    let saved: Found | undefined;
    for (let attempt = 1; saved === undefined; attempt += 1) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const nodeProps = {
        id,
        sourceIds: [],
        ...storedFields,
        ...fileFields,
        sensitivity: label,
        status: 'active',
        owner,
        version: 1,
        createdAt: now,
        createdBy: caller.userId,
        updatedAt: now,
        updatedBy: caller.userId,
        origin: 'manual',
        reviewStatus: 'pending',
      };
      try {
        saved = await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
          // The control again inside the write, locked, so a change since the check is seen and two
          // adds of the same file run one after the other.
          await run(tx, lockControlQuery(controlId));
          const [cp] = await props(tx, controlForWriteQuery(controlId));
          const end = cp ? toStoredControl(cp) : null;
          if (!end || !isVisible(caller.clearance, end.label)) throw NOT_FOUND();
          if (!canAddEvidence(caller, end)) throw FORBIDDEN();
          const counted = await run(tx, attachedCountQuery(end.id, fileHash));
          if (Number(counted.records[0]?.get('n') ?? 0) > 0) throw EVIDENCE_EXISTS();
          const number = await takeEvidenceNumber(tx);
          const link = { createdAt: now, createdBy: caller.userId };
          const [p] = await props(tx, createEvidenceQuery(end.id, toNeo({ ...nodeProps, number }), link));
          if (!p) throw NOT_FOUND();
          const after = {
            ...fields,
            label,
            owner,
            status: 'active',
            reviewStatus: 'pending',
            documentId: fileFields.documentId,
            fileHash: fileFields.fileHash,
            format: fileFields.format,
            sizeBytes: fileFields.sizeBytes,
            supports: end.id,
          };
          const result: Found = { p, controls: [end] };
          return { result, audit: this.entry('record.created', p, null, after, label) };
        });
      } catch (err) {
        if (isNumberClash(err) && attempt < NUMBER_CLASH_ATTEMPTS) continue;
        throw this.failed(err, 'evidence create failed', { orgId: caller.orgId, evidenceId: id, controlId });
      }
    }
    const [out] = await this.present(caller, [saved]);
    return out!;
  }

  async get(caller: Caller, id: string): Promise<EvidenceOut> {
    const item = await this.findVisible(caller, id);
    if (!item) throw NOT_FOUND();
    const [out] = await this.present(caller, [item]);
    return out!;
  }

  async list(caller: Caller, query: unknown): Promise<Paged<EvidenceOut>> {
    const q = parseEvidenceListQuery(query);
    if (ROLE_TABLE.evidence[caller.role] === 'none') throw FORBIDDEN();
    const today = this.today();
    const page = await this.read(caller, async (tx, scope) => {
      const built = evidenceListQueries(q, scope, today);
      const counted = await run(tx, built.count);
      const total = Number(counted.records[0]?.get('total') ?? 0);
      return { total, items: await found(tx, built.page) };
    });
    const items = await this.present(
      caller,
      page.items.filter((item) => evidenceVisibleTo(caller, item)),
    );
    return { items, page: q.page, pageSize: q.pageSize, total: page.total };
  }

  /** The visible evidence supporting one visible control. A role that never views evidence gets
   * 403 (a list of a type it can't view); a hidden or missing control is 404. For a Control Owner
   * on a control they own, that's every item on it within their clearance, whoever added it. */
  async forControl(caller: Caller, controlId: string, query: unknown): Promise<{ items: EvidenceOut[] }> {
    const q = parseControlEvidenceQuery(query);
    if (ROLE_TABLE.evidence[caller.role] === 'none') throw FORBIDDEN();
    if (ROLE_TABLE.control[caller.role] === 'none' || !isRecordId(controlId)) throw NOT_FOUND();
    const rows = await this.read(caller, async (tx, scope) => {
      const [cp] = await props(tx, controlGetQuery(controlId, scope));
      if (!cp || !controlVisibleTo(caller, toStoredControl(cp))) return null;
      return found(tx, controlEvidenceQuery(controlId, scope, q.status));
    });
    if (!rows) throw NOT_FOUND();
    return {
      items: await this.present(
        caller,
        rows.filter((item) => evidenceVisibleTo(caller, item)),
      ),
    };
  }

  async update(caller: Caller, id: string, input: unknown): Promise<EvidenceOut> {
    const today = this.today();
    const body = intakeUpdateSchemasOn(today).evidence.parse(input ?? {});
    const { version, ...given } = body;
    if (given.owner !== undefined && ROLE_TABLE.evidence[caller.role] !== 'none') {
      if (!(await isOrgMember(this.db, caller, given.owner))) throw BAD_OWNER();
    }
    return this.change(caller, id, version, 'evidence update failed', (stored) => {
      const changes: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(given)) {
        if (value === undefined) continue;
        changes[field === 'label' ? 'sensitivity' : field] = value;
      }
      const to = changes['sensitivity'] as Label | undefined;
      const from = stored['sensitivity'] as Label;
      if (to !== undefined && to !== from) {
        if (!isVisible(caller.clearance, to) || !canChangeLabel(caller.role, from, to)) throw LABEL_FORBIDDEN();
      }
      // The date rules on the merged evidence: a valid-until date before a stored collected date.
      const merged = { ...stored, ...changes };
      const problems = evidenceDateProblems(
        {
          collectedDate: String(merged['collectedDate']),
          validUntil: (merged['validUntil'] as string | null | undefined) ?? null,
        },
        today,
      );
      if (problems.length > 0) {
        const message = problems.map((p) => `${p.field}: ${evidenceDateMessage(p)}`).join('; ');
        throw new ApiError(400, 'validation_failed', message);
      }
      return { action: 'record.updated', changes };
    });
  }

  async retire(caller: Caller, id: string, version: number): Promise<EvidenceOut> {
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(400, 'validation_failed', 'version: must be a whole number from 1.');
    }
    return this.change(caller, id, version, 'evidence retire failed', () => ({
      action: 'record.retired',
      changes: { status: 'retired' },
    }));
  }

  /** The file of a visible evidence item, after its `document.downloaded` entry is written. The
   * document row is read under the intake system context, only once `canSeeEvidence` passed (R12). */
  async download(caller: Caller, id: string): Promise<EvidenceFile> {
    const item = await this.findVisible(caller, id);
    if (!item) throw NOT_FOUND();
    const record = toRecord(item.p);
    const row = isRecordId(record.documentId)
      ? await withOrgContext(this.db, INTAKE_SYSTEM_CONTEXT(caller.orgId), async (tx) => {
          const [r] = await tx
            .select({ id: documents.id, storageKey: documents.storageKey, label: documents.label })
            .from(documents)
            .where(and(eq(documents.orgId, caller.orgId), eq(documents.id, record.documentId)))
            .limit(1);
          return r;
        })
      : undefined;
    const key = row?.storageKey ?? record.fileKey;

    let body: Buffer;
    try {
      body = await this.files.get(caller.orgId, key);
    } catch (err) {
      this.log.error(
        { ...errorKind(err), orgId: caller.orgId, evidenceId: record.id, documentId: record.documentId },
        'the stored file of an evidence item could not be read',
      );
      throw new DocumentFileUnreadable();
    }

    const label = row ? higher(record.label, row.label) : record.label;
    await withOrgContext(this.db, contextOf(caller), (tx) =>
      this.audit.appendInTx(tx, {
        orgId: caller.orgId,
        ...actorOf(caller),
        action: 'document.downloaded',
        targetType: 'document',
        targetId: record.documentId,
        meta: { kind: 'evidence', label, evidenceId: record.id, number: record.number },
      }),
    );

    return {
      body,
      contentType: FORMAT_CONTENT_TYPES[record.format],
      disposition: attachmentDisposition(record.fileName),
    };
  }

  /** The shared path of update and retire: lock, check, compare the version, save, audit. */
  private async change(
    caller: Caller,
    id: string,
    version: number,
    failure: string,
    plan: (stored: Record<string, unknown>) => { action: string; changes: Record<string, unknown> },
  ): Promise<EvidenceOut> {
    if (ROLE_TABLE.evidence[caller.role] === 'none' || !isRecordId(id)) throw NOT_FOUND();
    let saved: Found;
    try {
      saved = await this.outbox.withAuditedWrite(caller.orgId, actorOf(caller), async (tx) => {
        await run(tx, lockEvidenceQuery(id));
        const [current] = await found(tx, evidenceForWriteQuery(id));
        if (!current || !evidenceVisibleTo(caller, current)) throw NOT_FOUND();
        if (!evidenceEditableBy(caller, current)) throw FORBIDDEN();
        if (Number(current.p['version']) !== version) throw new ApiError(409, 'stale_version', STALE_MESSAGE);
        const { action, changes } = plan(current.p);

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const [prop, value] of Object.entries(changes)) {
          const old = current.p[prop] ?? null;
          if (old === value) continue;
          before[apiName(prop)] = old;
          after[apiName(prop)] = value;
        }
        const now = new Date().toISOString();
        const next = { ...changes, version: version + 1, updatedAt: now, updatedBy: caller.userId };
        const [p] = await props(tx, saveEvidenceQuery(id, toNeo(next)));
        if (!p) throw NOT_FOUND();
        const label = higher(current.p['sensitivity'] as Label, p['sensitivity'] as Label);
        return { result: { p, controls: current.controls }, audit: this.entry(action, p, before, after, label) };
      });
    } catch (err) {
      throw this.failed(err, failure, { orgId: caller.orgId, evidenceId: id });
    }
    const [out] = await this.present(caller, [saved]);
    return out!;
  }

  /** An evidence item with its visible controls, if the caller can see it (checked by the query and
   * by our code). A malformed ID is the same as a missing one. */
  private async findVisible(caller: Caller, id: string): Promise<Found | null> {
    if (ROLE_TABLE.evidence[caller.role] === 'none' || !isRecordId(id)) return null;
    const [item] = await this.read(caller, (tx, scope) => found(tx, evidenceGetQuery(id, scope)));
    if (!item || !evidenceVisibleTo(caller, item)) return null;
    return item;
  }

  /** The control evidence would be added to: found if its label is visible to the caller (the
   * owner rule is `canAddEvidence`'s, so a Control Owner gets 403 on a control someone else owns).
   * The Control Owner's accounts can't read controls, so their lookup runs as the writer. */
  private async findControlForAdd(caller: Caller, id: string): Promise<StoredControl | null> {
    if (!isRecordId(id)) return null;
    const q = controlGetQuery(id, { clearance: caller.clearance });
    const lookup = (tx: ManagedTransaction) => props(tx, q);
    const [p] = can(caller.role, 'control', 'view')
      ? await this.graph.readAs(caller.orgId, caller.role, caller.clearance, lookup, {
          timeoutMs: EVIDENCE_READ_TIMEOUT_MS,
        })
      : await this.graph.read(caller.orgId, lookup);
    if (!p) return null;
    const control = toStoredControl(p);
    return isVisible(caller.clearance, control.label) ? control : null;
  }

  /** The caller's read scope (D213 (3)): a Control Owner sees evidence only on visible controls they
   * own, and only their own controls. */
  private scopeOf(caller: Caller): EvidenceScope {
    const scope: EvidenceScope = { clearance: caller.clearance };
    if (ROLE_TABLE.evidence[caller.role] === 'upload_own') scope.evidenceOwnerOnly = caller.userId;
    if (ROLE_TABLE.control[caller.role] === 'edit_own') scope.controlOwnerOnly = caller.userId;
    return scope;
  }

  /** Runs a read as the caller's read-only account, or, for an "own" cell (no shared account can
   * know who owns what), as the writer with the owner conditions in every query. */
  private read<T>(caller: Caller, fn: (tx: ManagedTransaction, scope: EvidenceScope) => Promise<T>): Promise<T> {
    const scope = this.scopeOf(caller);
    if (scope.evidenceOwnerOnly !== undefined || scope.controlOwnerOnly !== undefined) {
      return this.graph.read(caller.orgId, (tx) => fn(tx, scope));
    }
    return this.graph.readAs(caller.orgId, caller.role, caller.clearance, (tx) => fn(tx, scope), {
      timeoutMs: EVIDENCE_READ_TIMEOUT_MS,
    });
  }

  /** The API's answers for visible items: the controls the caller can see, `validity` today, the
   * reviewer's name, and `canEdit`. */
  private async present(caller: Caller, items: readonly Found[]): Promise<EvidenceOut[]> {
    const reviewers = [
      ...new Set(
        items.map((item) => item.p['reviewedBy']).filter((v): v is string => typeof v === 'string' && v !== ''),
      ),
    ];
    const names = await this.userNames(caller, reviewers);
    const today = this.today();
    return items.map((item) => {
      const record = toRecord(item.p);
      const controls = item.controls
        .filter((c) => controlVisibleTo(caller, c))
        .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0))
        .map((c) => ({ id: c.id, number: c.number, name: c.name, label: c.label, status: c.status }));
      return {
        ...record,
        controls,
        validity: evidenceValidity(record.validUntil, today),
        reviewer:
          record.reviewedBy === null
            ? null
            : { id: record.reviewedBy, name: names.get(record.reviewedBy) ?? record.reviewedBy },
        canEdit: evidenceEditableBy(caller, item),
      };
    });
  }

  /** The names of the given members of the caller's org (in the caller's org context). */
  private async userNames(caller: Caller, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await withOrgContext(this.db, contextOf(caller), (tx) =>
      tx
        .select({ id: user.id, name: user.name })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, caller.orgId), inArray(user.id, [...ids]))),
    );
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private entry(
    action: string,
    p: Record<string, unknown>,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    label: Label,
  ): OutboxAudit {
    return {
      action,
      targetType: 'evidence',
      targetId: p['id'] as string,
      before,
      after,
      meta: { number: p['number'] as string, label },
    };
  }

  /** Our refusals pass through; anything else is logged by its type, code and IDs only. */
  private failed(err: unknown, message: string, ids: Record<string, string>): unknown {
    if (err instanceof ApiError) return err;
    const fields = errorKind(err);
    this.log.error({ ...ids, ...fields }, message);
    return new EvidenceWriteFailed(fields.errorCode);
  }
}
