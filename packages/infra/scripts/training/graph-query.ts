// The `graph_query` job's rows (TR-002; D15, D22, D45.8, D52.1, D52.2, D248, D250): a question about
// a generated org, the app's own graph-query request for it, and a correct read-only Cypher query.
//
// Questions: for every world and org, each of the benchmark's QUESTION_SHAPES (12 single-hop, 8
// multi-hop) × each answer-key record of the shape's start kind, in the shape's own words
// (`shape.text(name)`). Then a few questions about made-up names (`madeUpName`, checked with
// `isMadeUp`), at most one row in MADE_UP_ONE_IN (10%): the model still writes a reading query, and
// it finds nothing.
//
// Role: a seeded pick among the ROLES that view every kind on the shape's path and every link type
// it follows (`viewedKinds`, `viewedLinkRows`), so the prompt's graph holds the whole path. The
// row's texts are `graphQueryRequest(role, question)`: its instructions and its data.
//
// The correct query, one fixed pattern per shape, in the style of the prompt's first example:
//   MATCH p = (a:<Start>)-[:<T>]->(b:<Next>)[-[:<T2>]->(c:<End>)]
//   WHERE toLower(a.name) CONTAINS '<the name in lower case, \ and ' escaped>' RETURN p LIMIT 50
// A step against a link's direction is `<-[:T]-`, two link types `[:HOSTS|RUNS]`; the labels are
// SEARCH_NODE_LABELS and each step's far kind comes from LINK_TYPES. The answer is
// `JSON.stringify({query})`.
//
// Checks, offline only (D250: no query runs in Neo4j):
// - every query passes `checkGraphQuery`, GRAPH_QUERY_ANSWER_SHAPE and `graphQueryAnswerSchema`,
//   and `cleanQuery` leaves it as it is; anything else is a bug (TrainingDataBug, exit 1);
// - the query's start match is worked out on the answer key: the records of the start kind whose
//   lower-case name contains the lower-case name. A real name that another record's name also
//   contains is skipped (`name_not_unique`); a made-up name must match no record at all;
// - the records the query returns are worked out on the answer key by following the steps
//   (`OrgGraph.follow`); a real-name question that reaches none is skipped (`no_path`).
import { createHash } from 'node:crypto';
import type { TextRequest } from '../../../api/src/ai/text-model.js';
import { viewedKinds, viewedLinkRows } from '../../../api/src/search/graph/graph-description.js';
import {
  GRAPH_QUERY_ANSWER_SHAPE,
  GRAPH_QUERY_PROMPT_VERSION,
  cleanQuery,
  graphQueryAnswerSchema,
  graphQueryRequest,
} from '../../../api/src/search/graph/prompt.js';
import { checkGraphQuery } from '../../../api/src/search/graph/query-check.js';
import {
  OrgGraph,
  QUESTION_SHAPES,
  assetPrefixOf,
  isMadeUp,
  madeUpName,
  type GraphRecord,
  type QuestionShape,
} from '../../../benchmark/src/index.js';
// The generators' seeded faker (seed, org index, stream), which `madeUpName` draws from.
import { fakerFor } from '../../../generators/src/sources/mess.js';
import {
  LINK_TYPES,
  ROLES,
  SEARCH_LIMITS,
  SEARCH_NODE_LABELS,
  type LinkType,
  type RecordKind,
  type Role,
} from '../../../shared/src/index.js';
import {
  MADE_UP_ONE_IN,
  TrainingDataBug,
  type JobBuilder,
  type TrainingExample,
  type TrainingWorld,
  type WorldExamples,
} from './rows.js';

/** Why a question is left out, in the order they are reported. */
export const GRAPH_QUERY_DROP_REASONS = ['name_not_unique', 'no_path'] as const;
export type GraphQueryDropReason = (typeof GRAPH_QUERY_DROP_REASONS)[number];

/** The faker stream of the made-up names: apart from the generators' own streams (1 to 10). */
const MADE_UP_STREAM = 101;
/** Made-up names tried for one question before its shape's turn passes. */
const MADE_UP_TRIES = 50;

/** The node variables of a pattern, in order: every letter but `p`, the path's. */
const NODE_VARIABLES = 'abcdefghijklmnoqrstuvwxyz';

/** One link a path follows: its type, from one kind to another in the link's own direction. */
export interface PathLink {
  type: LinkType;
  from: RecordKind;
  to: RecordKind;
}

/** A shape's path: the kind of each node, the start's first, and every link type it follows. */
export interface ShapePath {
  kinds: RecordKind[];
  links: PathLink[];
}

/** The shape's path, from LINK_TYPES. Throws TrainingDataBug for a step no link type allows. */
export function shapePath(shape: QuestionShape): ShapePath {
  if (shape.steps.length > NODE_VARIABLES.length - 1) {
    throw new TrainingDataBug(`shape ${shape.id} has more steps than its pattern can name`);
  }
  const kinds: RecordKind[] = [shape.start];
  const links: PathLink[] = [];
  shape.steps.forEach((step, i) => {
    const here = kinds[i]!;
    if (step.types.length === 0) throw new TrainingDataBug(`shape ${shape.id}, step ${i + 1} has no link type`);
    let next: RecordKind | undefined;
    for (const type of step.types) {
      const row = LINK_TYPES.find((r) => r.type === type && (step.direction === 'out' ? r.from : r.to) === here);
      if (row === undefined) {
        throw new TrainingDataBug(`shape ${shape.id}, step ${i + 1}: no ${type} link has a ${here} at that end`);
      }
      const far = step.direction === 'out' ? row.to : row.from;
      if (next !== undefined && far !== next) {
        throw new TrainingDataBug(`shape ${shape.id}, step ${i + 1}: its link types lead to different kinds`);
      }
      next = far;
      if (!links.some((l) => l.type === row.type && l.from === row.from && l.to === row.to)) {
        links.push({ type: row.type, from: row.from, to: row.to });
      }
    }
    kinds.push(next!);
  });
  return { kinds, links };
}

/** The roles that view every kind on the path and every link it follows, in ROLES order. */
export function rolesSeeing(path: ShapePath): Role[] {
  return ROLES.filter((role) => {
    const kinds = new Set<string>(viewedKinds(role));
    const rows = viewedLinkRows(role);
    return (
      path.kinds.every((kind) => kinds.has(kind)) &&
      path.links.every((link) => rows.some((r) => r.type === link.type && r.from === link.from && r.to === link.to))
    );
  });
}

/** A seeded pick of one of `roles`: the same parts always pick the same role. */
export function pickRole(roles: readonly Role[], parts: readonly (string | number)[]): Role {
  if (roles.length === 0) throw new TrainingDataBug('no role to pick from');
  const hash = createHash('sha256')
    .update(`role|${parts.join('|')}`)
    .digest('hex');
  return roles[Number.parseInt(hash.slice(0, 8), 16) % roles.length]!;
}

/** The text as a Cypher string's contents: `\` and `'` escaped. */
export function cypherText(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

/** The shape's query about the named start record (see the top of the file). */
export function graphQueryOf(shape: QuestionShape, name: string): string {
  const { kinds } = shapePath(shape);
  const node = (i: number): string => `(${NODE_VARIABLES[i]!}:${SEARCH_NODE_LABELS[kinds[i]!]})`;
  let pattern = node(0);
  shape.steps.forEach((step, i) => {
    const link = `[:${step.types.join('|')}]`;
    pattern += step.direction === 'out' ? `-${link}->` : `<-${link}-`;
    pattern += node(i + 1);
  });
  const start = NODE_VARIABLES[0]!;
  return (
    `MATCH p = ${pattern} WHERE toLower(${start}.name) CONTAINS '${cypherText(name.toLowerCase())}' ` +
    `RETURN p LIMIT ${SEARCH_LIMITS.graphRows}`
  );
}

/** The records of `kind` the query's start matches: those whose lower-case name holds the name's. */
export function startMatches(records: readonly GraphRecord[], kind: RecordKind, name: string): GraphRecord[] {
  const needle = name.toLowerCase();
  return records.filter((record) => record.kind === kind && record.name.toLowerCase().includes(needle));
}

/**
 * Null when `value` is a graph-query answer the app takes as it is: it passes
 * GRAPH_QUERY_ANSWER_SHAPE and `graphQueryAnswerSchema`, `cleanQuery` leaves its query unchanged,
 * `checkGraphQuery` lets it run and (when given) it is `expected`. Else what is wrong, without
 * the query's text.
 */
export function checkGraphQueryAnswerValue(value: unknown, expected?: string): string | null {
  if (!GRAPH_QUERY_ANSWER_SHAPE.safeParse(value).success) return 'the answer does not pass GRAPH_QUERY_ANSWER_SHAPE';
  const parsed = graphQueryAnswerSchema.safeParse(value);
  if (!parsed.success) return 'the answer does not pass graphQueryAnswerSchema';
  const query = parsed.data.query;
  if (cleanQuery(query) !== query) return 'cleanQuery would change the query';
  const check = checkGraphQuery(query);
  if (!check.ok) return `checkGraphQuery refuses the query (${check.reason})`;
  if (expected !== undefined && query !== expected) return "the query read back is not the row's query";
  return null;
}

interface Asked {
  shape: QuestionShape;
  role: Role;
  /** The name the question and its query use. */
  name: string;
  madeUp: boolean;
}

function exampleOf(seed: number, asked: Asked, where: string): TrainingExample {
  const question = asked.shape.text(asked.name);
  const query = graphQueryOf(asked.shape, asked.name);
  const answer = { query };
  const problem = checkGraphQueryAnswerValue(answer, query);
  if (problem !== null) throw new TrainingDataBug(`${where}: ${problem}`);
  // The app's request for the question, as Path B sends it to the text model.
  const request: TextRequest<unknown> = graphQueryRequest(asked.role, question);
  const example: TrainingExample = {
    job: 'graph_query',
    seed,
    system: request.instructions,
    user: request.data,
    assistant: JSON.stringify(answer),
    request,
  };
  if (asked.madeUp) example.madeUp = true;
  return example;
}

/** For each shape (by ID), the roles that see all of its path; a shape no role sees is a bug. */
function shapeRoles(): Map<string, Role[]> {
  const out = new Map<string, Role[]>();
  for (const shape of QUESTION_SHAPES) {
    const roles = rolesSeeing(shapePath(shape));
    if (roles.length === 0) {
      throw new TrainingDataBug(`no role views every kind and link of shape ${shape.id}`);
    }
    out.set(shape.id, roles);
  }
  return out;
}

/** One world's questions, each org's real-name ones then its made-up ones (see the top of the file). */
function worldExamples(world: TrainingWorld): WorldExamples {
  const examples: TrainingExample[] = [];
  const dropped: Record<GraphQueryDropReason, number> = { name_not_unique: 0, no_path: 0 };
  const roles = shapeRoles();
  for (const [orgIndex, org] of world.key.orgs.entries()) {
    const graph = OrgGraph.ofOrg(org);
    const orgExamples: TrainingExample[] = [];

    // Real names: every shape × every record of its start kind.
    for (const shape of QUESTION_SHAPES) {
      for (const start of graph.ofKind(shape.start)) {
        if (startMatches(graph.records, shape.start, start.name).some((match) => match.key !== start.key)) {
          dropped.name_not_unique += 1;
          continue;
        }
        if (graph.follow(start.key, shape.steps).length === 0) {
          dropped.no_path += 1;
          continue;
        }
        const role = pickRole(roles.get(shape.id)!, [world.seed, org.key, shape.id, start.key]);
        const where = `world ${world.seed}, org ${org.key}, shape ${shape.id}, record ${start.key}`;
        orgExamples.push(exampleOf(world.seed, { shape, role, name: start.name, madeUp: false }, where));
      }
    }

    // Made-up names: the shapes in a seeded order take turns, at most one row in MADE_UP_ONE_IN.
    const wanted = Math.floor(orgExamples.length / (MADE_UP_ONE_IN - 1));
    const faker = fakerFor(world.seed, orgIndex, MADE_UP_STREAM);
    const shapes = faker.helpers.shuffle([...QUESTION_SHAPES]);
    const prefix = assetPrefixOf(org.name, graph.records);
    const used = new Set<string>();
    let made = 0;
    for (let turn = 0; made < wanted && turn < wanted * shapes.length; turn++) {
      const shape = shapes[turn % shapes.length]!;
      for (let tries = 0; tries < MADE_UP_TRIES; tries++) {
        const name = madeUpName(faker, shape.start, prefix);
        if (used.has(name) || !isMadeUp(name, graph.records)) continue;
        // The query matches no record, so it finds nothing.
        if (startMatches(graph.records, shape.start, name).length > 0) continue;
        used.add(name);
        const role = pickRole(roles.get(shape.id)!, [world.seed, org.key, shape.id, 'made-up', name]);
        const where = `world ${world.seed}, org ${org.key}, shape ${shape.id}, made-up name ${made + 1}`;
        orgExamples.push(exampleOf(world.seed, { shape, role, name, madeUp: true }, where));
        made += 1;
        break;
      }
    }
    examples.push(...orgExamples);
  }
  return { examples, dropped };
}

export const graphQueryBuilder: JobBuilder = {
  job: 'graph_query',
  promptVersion: GRAPH_QUERY_PROMPT_VERSION,
  dropReasons: GRAPH_QUERY_DROP_REASONS,
  build: (world) => Promise.resolve(worldExamples(world)),
  checkAnswer(value: unknown, example: TrainingExample): string | null {
    let expected: unknown;
    try {
      expected = JSON.parse(example.assistant);
    } catch {
      return "the row's answer is not JSON";
    }
    const parsed = GRAPH_QUERY_ANSWER_SHAPE.safeParse(expected);
    if (!parsed.success) return "the row's answer does not pass GRAPH_QUERY_ANSWER_SHAPE";
    return checkGraphQueryAnswerValue(value, parsed.data.query);
  },
};
