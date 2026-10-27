// Round 2 of the real-data training file (D258): the pieces round 1 lacked, for
// `train-data-real.ts --round 2`. Pure: no I/O.
// - IMPACTS sentences (round 1 had none) and decoys that name an incident and an asset but state no
//   link, from the generators' own wording (packages/generators/src/sources/mess.ts) and a few more.
// - More GOVERNED_BY wording, and list sentences that state several MITIGATED_BY links at once, for
//   dense passages (round 1's passages held 1–3 links; policy documents hold 9 or more).
// - Policy names for the 800-53 families whose "<Family> Policy" name Company X uses: common topic
//   policy names instead, so GOVERNED_BY gets examples without Company X's names.
// - Framework questions for the `graph_query` job: controls SATISFIES requirements, requirements
//   MAPS_TO other frameworks' requirements (the app's catalogs and NIST's mappings), and the risks
//   those controls mitigate.
// - The `answer` job: the app's own context format (`buildContext`) and answer prompt
//   (`answerRequest`) over real records, and an answer that cites every statement.
import { answerRequest } from '../../../api/src/chat/answer-prompt.js';
import { viewedKinds, viewedLinkRows } from '../../../api/src/search/graph/graph-description.js';
import { buildContext } from '../../../api/src/search/hybrid/context.js';
import type { ContextSelection, FusedEntry } from '../../../api/src/search/hybrid/fusion.js';
import {
  ROLES,
  SEARCH_LIMITS,
  type KeyFieldValue,
  type Role,
  type SearchRecordKind,
} from '../../../shared/src/index.js';
import { cypherText } from './graph-query.js';
import { TrainingDataBug } from './rows.js';

// ---- extraction wording ------------------------------------------------------------------------
export const IMPACTS_SENTENCES: readonly string[] = [
  'The incident {from} impacted {to}.',
  '{to} was affected by the incident {from}.',
  'The incident {from} disrupted service on {to}.',
  'During the incident {from}, {to} was compromised.',
  '{to} was taken offline by the incident {from}.',
  'The incident {from} affected {to}.',
];

/** Sentences that name an incident and an asset but deny the link: no IMPACTS link is reported. */
export const IMPACTS_DECOYS: readonly string[] = [
  'While triaging the incident {from}, analysts also checked {to} and found it unaffected.',
  'The incident {from} was first suspected on {to}, but that system showed no sign of compromise.',
];

export const MORE_GOVERNED_SENTENCES: readonly string[] = [
  'The {from} control is governed by the {to}.',
  'The {to} governs the {from} control.',
  'Under the {to}, the {from} control is required.',
  'The {from} control falls under the {to}.',
];

/** One sentence that states MITIGATED_BY from one risk to several controls. */
export const MITIGATED_LIST_SENTENCES: readonly string[] = [
  'The risk {from} is mitigated by the {list} controls.',
  'To reduce the risk {from}, the organisation relies on the {list} controls.',
];

/** "A, B and C". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

// ---- policy names ------------------------------------------------------------------------------
/** Topic policies by 800-53 family, for a family whose "<Family> Policy" name can't be used. */
export const TOPIC_POLICIES: Readonly<Record<string, readonly string[]>> = {
  AC: ['Identity and Access Management Policy', 'Remote Access Policy'],
  CA: ['Security Assessment Policy'],
  CM: ['Change Management Policy', 'Secure Configuration Policy'],
  CP: ['Business Continuity Policy', 'Backup Policy'],
  IA: ['Authentication Policy', 'Password Policy'],
  RA: ['Vulnerability Management Policy'],
  SA: ['Secure Development Policy'],
  SC: ['Network Security Policy', 'Cryptography Policy'],
  SI: ['Malware Protection Policy', 'Logging and Monitoring Policy'],
  SR: ['Supplier Security Policy'],
};

// ---- framework questions (graph_query) ----------------------------------------------------------
export interface Requirement {
  framework: 'nist_800_53' | 'nist_csf_2' | 'iso_27001';
  code: string;
  title: string;
}

const FRAMEWORK_NAMES: Readonly<Record<Requirement['framework'], readonly string[]>> = {
  nist_800_53: ['NIST 800-53', 'NIST SP 800-53', '800-53'],
  nist_csf_2: ['NIST CSF 2.0', 'CSF 2.0', 'the CSF'],
  iso_27001: ['ISO 27001', 'ISO/IEC 27001'],
};

/** One link of a framework question's path, in the link's own direction. */
interface FrameworkLink {
  type: 'SATISFIES' | 'MAPS_TO' | 'MITIGATED_BY';
  from: SearchRecordKind;
  to: SearchRecordKind;
}

export interface FrameworkShape {
  id: string;
  kind: 'single_hop' | 'multi_hop';
  /** The start: a requirement of this framework, or a control. */
  start: Requirement['framework'] | 'control';
  /** The question's wordings; `{r}` is the requirement as the question names it, `{n}` a name. */
  texts: readonly string[];
  /** The pattern after `MATCH p = `, the start node named `a`. */
  pattern: string;
  /** A condition on the far requirement `b`, when the start's links reach other frameworks too. */
  endFramework?: Requirement['framework'];
  kinds: readonly SearchRecordKind[];
  links: readonly FrameworkLink[];
}

const SAT: FrameworkLink = { type: 'SATISFIES', from: 'control', to: 'requirement' };
const MAP: FrameworkLink = { type: 'MAPS_TO', from: 'requirement', to: 'requirement' };
const MIT: FrameworkLink = { type: 'MITIGATED_BY', from: 'risk', to: 'control' };

export const FRAMEWORK_SHAPES: readonly FrameworkShape[] = [
  {
    id: 'requirement_satisfied_by',
    kind: 'single_hop',
    start: 'nist_800_53',
    texts: [
      'Which controls satisfy {r}?',
      'What controls meet the requirement {r}?',
      'List the controls that satisfy {r}.',
    ],
    pattern: '(a:Requirement)<-[:SATISFIES]-(b:Control)',
    kinds: ['requirement', 'control'],
    links: [SAT],
  },
  {
    id: 'control_satisfies',
    kind: 'single_hop',
    start: 'control',
    texts: ['Which framework requirements does the {n} control satisfy?', 'What requirements does {n} meet?'],
    pattern: '(a:Control)-[:SATISFIES]->(b:Requirement)',
    kinds: ['control', 'requirement'],
    links: [SAT],
  },
  {
    id: 'csf_maps_to',
    kind: 'single_hop',
    start: 'nist_csf_2',
    texts: ['Which NIST 800-53 requirements does {r} map to?', 'What does {r} map to in 800-53?'],
    pattern: '(a:Requirement)-[:MAPS_TO]->(b:Requirement)',
    endFramework: 'nist_800_53',
    kinds: ['requirement'],
    links: [MAP],
  },
  {
    id: 'mapped_from_csf',
    kind: 'single_hop',
    start: 'nist_800_53',
    texts: ['Which CSF 2.0 requirements map to {r}?', 'What in NIST CSF 2.0 maps to {r}?'],
    pattern: '(a:Requirement)<-[:MAPS_TO]-(b:Requirement)',
    endFramework: 'nist_csf_2',
    kinds: ['requirement'],
    links: [MAP],
  },
  {
    id: 'maps_to_iso',
    kind: 'single_hop',
    start: 'nist_800_53',
    texts: ['Which ISO 27001 requirements does {r} map to?', 'What does {r} map to in ISO 27001?'],
    pattern: '(a:Requirement)-[:MAPS_TO]->(b:Requirement)',
    endFramework: 'iso_27001',
    kinds: ['requirement'],
    links: [MAP],
  },
  {
    id: 'csf_met_by_controls',
    kind: 'multi_hop',
    start: 'nist_csf_2',
    texts: ['Which controls help meet {r}?', 'What controls support {r} through its 800-53 mappings?'],
    pattern: '(a:Requirement)-[:MAPS_TO]->(b:Requirement)<-[:SATISFIES]-(c:Control)',
    kinds: ['requirement', 'control'],
    links: [MAP, SAT],
  },
  {
    id: 'iso_met_by_controls',
    kind: 'multi_hop',
    start: 'iso_27001',
    texts: [
      'Which controls help meet {r}?',
      'What controls support {r} through the 800-53 requirements that map to it?',
    ],
    pattern: '(a:Requirement)<-[:MAPS_TO]-(b:Requirement)<-[:SATISFIES]-(c:Control)',
    kinds: ['requirement', 'control'],
    links: [MAP, SAT],
  },
  {
    id: 'requirement_risks',
    kind: 'multi_hop',
    start: 'nist_800_53',
    texts: [
      'Which risks are mitigated by the controls that satisfy {r}?',
      'What risks do the controls meeting {r} reduce?',
    ],
    pattern: '(a:Requirement)<-[:SATISFIES]-(b:Control)<-[:MITIGATED_BY]-(c:Risk)',
    kinds: ['requirement', 'control', 'risk'],
    links: [SAT, MIT],
  },
];

/** The requirement as a question names it: its framework and code, sometimes its title too. */
export function requirementWords(req: Requirement, choice: number): string {
  const names = FRAMEWORK_NAMES[req.framework];
  const framework = names[choice % names.length]!;
  return choice % 3 === 0 ? `${framework} ${req.code} (${req.title.replace(/…$/, '')})` : `${framework} ${req.code}`;
}

/** The shape's question, its wording picked by `choice`. */
export function frameworkQuestion(shape: FrameworkShape, start: Requirement | string, choice: number): string {
  const text = shape.texts[choice % shape.texts.length]!;
  return typeof start === 'string' ? text.replace('{n}', start) : text.replace('{r}', requirementWords(start, choice));
}

/** The shape's query: a requirement start by framework and code, a control start by its name. */
export function frameworkQuery(shape: FrameworkShape, start: Requirement | string): string {
  const where =
    typeof start === 'string'
      ? `toLower(a.name) CONTAINS '${cypherText(start.toLowerCase())}'`
      : `a.framework = '${start.framework}' AND a.code = '${cypherText(start.code)}'`;
  const end = shape.endFramework === undefined ? '' : ` AND b.framework = '${shape.endFramework}'`;
  return `MATCH p = ${shape.pattern} WHERE ${where}${end} RETURN p LIMIT ${SEARCH_LIMITS.graphRows}`;
}

/** The roles that view every kind and link the shape uses, in ROLES order. */
export function frameworkRoles(shape: FrameworkShape): Role[] {
  return ROLES.filter((role) => {
    const kinds = new Set<string>(viewedKinds(role));
    const rows = viewedLinkRows(role);
    return (
      shape.kinds.every((kind) => kinds.has(kind)) &&
      shape.links.every((link) => rows.some((r) => r.type === link.type && r.from === link.from && r.to === link.to))
    );
  });
}

// ---- the answer job --------------------------------------------------------------------------------
/** A record as the answer's context shows it. */
export interface ContextRecord {
  key: string;
  kind: SearchRecordKind;
  name: string;
  number: string;
  keyFields: Record<string, KeyFieldValue>;
}

export interface ContextPassage {
  key: string;
  documentName: string;
  documentKind: 'policy_document' | 'soc_ticket' | 'audit_report';
  text: string;
}

export type ContextItem = { type: 'record'; record: ContextRecord } | { type: 'passage'; passage: ContextPassage };

/**
 * The app's context for these items in this order (`buildContext`, as hybrid search writes it), with
 * the links among the records, then the app's answer request for the question. Returns the source
 * number of each item's key too.
 */
export function answerPrompt(
  items: readonly ContextItem[],
  links: readonly { type: string; from: string; to: string }[],
  question: string,
): { instructions: string; data: string; numberOf: Map<string, number> } {
  const kept = items.map((item, index): FusedEntry => {
    const rank = index + 1;
    const common = { rank, bestRank: rank, score: 1 / (60 + rank), foundBy: [], ranks: {} };
    if (item.type === 'record') {
      const r = item.record;
      return {
        ...common,
        key: `record:${r.key}`,
        item: {
          type: 'record',
          record: {
            id: r.key,
            number: r.number,
            name: r.name,
            kind: r.kind,
            label: 'internal',
            status: 'active',
            keyFields: r.keyFields,
          },
        },
      } as unknown as FusedEntry;
    }
    const p = item.passage;
    return {
      ...common,
      key: `passage:${p.key}`,
      item: {
        type: 'passage',
        passage: {
          chunkId: p.key,
          documentId: p.key,
          documentName: p.documentName,
          documentKind: p.documentKind,
          position: 0,
          text: p.text,
          label: 'internal',
          similarity: 0.5,
        },
      },
    } as unknown as FusedEntry;
  });
  const selection = {
    entries: kept.map((entry) => ({ entry, inContext: true })),
    kept,
    links: links.map((l) => ({ type: l.type, from: l.from, to: l.to })),
  } as unknown as ContextSelection;
  const { context } = buildContext(selection, [], 'internal', kept.length);
  const request = answerRequest(context, question);
  const numberOf = new Map(
    items.map((item, index) => [item.type === 'record' ? item.record.key : item.passage.key, index + 1]),
  );
  return { instructions: request.instructions, data: request.data, numberOf };
}

/** How one step reads, from the start's side: `{s}` is the subject, `{l}` the list. */
const STEP_WORDS: Readonly<Record<string, string>> = {
  'MITIGATED_BY|out': '{s} is mitigated by {l}.',
  'MITIGATED_BY|in': '{s} mitigates {l}.',
  'EXPOSED_TO|out': '{s} is exposed to {l}.',
  'EXPOSED_TO|in': '{s} is a risk for {l}.',
  'GOVERNED_BY|out': '{s} is governed by {l}.',
  'GOVERNED_BY|in': '{s} governs {l}.',
  'EXPOSES|out': 'The incident {s} exposes {l}.',
  'EXPOSES|in': '{s} was exposed by {l}.',
  'IMPACTS|out': 'The incident {s} impacted {l}.',
  'IMPACTS|in': '{s} was impacted by {l}.',
  'SATISFIES|out': '{s} satisfies {l}.',
  'SATISFIES|in': '{s} is satisfied by {l}.',
  'MAPS_TO|out': '{s} maps to {l}.',
  'MAPS_TO|in': '{s} is mapped from {l}.',
};

/** One answer sentence: the subject and the records it reaches, each with its source number. */
export function stepSentence(
  type: string,
  direction: 'out' | 'in',
  subject: { name: string; n: number },
  reached: readonly { name: string; n: number }[],
): string {
  const words = STEP_WORDS[`${type}|${direction}`];
  if (words === undefined) throw new TrainingDataBug(`no answer wording for ${type} ${direction}`);
  const cited = reached.map((r) => `${r.name} [${r.n}]`);
  const list = reached.length > 6 ? `these:\n${cited.map((c) => `- ${c}`).join('\n')}` : andList(cited);
  const sentence = words.replace('{s}', `${subject.name} [${subject.n}]`).replace('{l}', list);
  return reached.length > 6 ? sentence.replace(/\.$/, '') : sentence;
}

/** The source numbers an answer cites: every number in square brackets. */
export function citedNumbers(answer: string): number[] {
  return [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
}
