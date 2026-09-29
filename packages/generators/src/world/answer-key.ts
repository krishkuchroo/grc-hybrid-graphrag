// The hidden answer key (D18): the world every generated source is written from, so each benchmark
// question has a known right answer.
import type { CreateRecordInput, LinkType, RecordKind } from '@grc/shared';
import type { SizeSpec } from './sizes.js';

/** Bumped whenever the same seed and size would give a different answer key (D45.8). */
export const GENERATOR_VERSION = '1';

/** A record: its stable key (`AST-0001` …) plus exactly the fields of S1's create schema for its kind. */
export type WorldRecord<K extends RecordKind = RecordKind> = { key: string } & CreateRecordInput<K>;

export interface WorldLink {
  type: LinkType;
  fromKey: string;
  toKey: string;
}

export interface WorldOrg {
  key: string;
  name: string;
  assets: WorldRecord<'asset'>[];
  risks: WorldRecord<'risk'>[];
  controls: WorldRecord<'control'>[];
  policies: WorldRecord<'policy'>[];
  incidents: WorldRecord<'incident'>[];
  links: WorldLink[];
}

export interface AnswerKey {
  generatorVersion: string;
  seed: number;
  size: SizeSpec;
  orgs: WorldOrg[];
}
