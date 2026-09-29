// Builds the answer key (D18) from a seed and a size. Every choice comes from a faker seeded with the
// world's seed and the org's place in it (D33, D45.8): no clock, no Math.random, no shared state.
import { Faker, base, en } from '@faker-js/faker';
import type { AssetType, Label } from '@grc/shared';
import { GENERATOR_VERSION, type AnswerKey, type WorldLink, type WorldOrg, type WorldRecord } from './answer-key.js';
import {
  NameBook,
  areaOf,
  assetName,
  controlOf,
  incidentName,
  orgName,
  policyName,
  riskName,
  slugOf,
} from './names.js';
import { SIZE_FIELDS, type SizeSpec } from './sizes.js';

/** Every date in the world is counted back from this fixed day, never from the clock. */
const REFERENCE_MS = Date.UTC(2026, 8, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

const HOSTS_OF_SERVERS: readonly AssetType[] = ['network_device', 'cloud_service'];

/** Types every estate of 4 or more assets has, so it always has HOSTS and RUNS links. */
const REQUIRED_TYPES: readonly AssetType[] = ['network_device', 'server', 'database', 'application'];

const TYPE_WEIGHTS: { value: AssetType; weight: number }[] = [
  { value: 'network_device', weight: 6 },
  { value: 'cloud_service', weight: 6 },
  { value: 'server', weight: 30 },
  { value: 'database', weight: 15 },
  { value: 'application', weight: 28 },
  { value: 'endpoint', weight: 15 },
];

const LABEL_WEIGHTS: { value: Label; weight: number }[] = [
  { value: 'public', weight: 1 },
  { value: 'internal', weight: 5 },
  { value: 'confidential', weight: 3 },
  { value: 'restricted', weight: 1 },
];

function checkSize(size: SizeSpec): void {
  for (const field of SIZE_FIELDS) {
    if (!Number.isInteger(size[field]) || size[field] < 0) throw new RangeError(`size.${field} must be a whole number`);
  }
  if (size.orgs < 1) throw new RangeError('size.orgs must be at least 1');
  if (size.risks > 0 && (size.assets < 1 || size.controls < 1)) {
    throw new RangeError('risks need at least one asset and one control');
  }
  if (size.controls > 0 && size.policies < 1) throw new RangeError('controls need at least one policy');
  if (size.incidents > 0 && size.assets < 1) throw new RangeError('incidents need at least one asset');
}

function keyOf(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(4, '0')}`;
}

/** `count` different items of `items`, in the order drawn (count is capped at the list's length). */
function pickDistinct<T>(faker: Faker, items: readonly T[], count: number): T[] {
  const n = Math.min(count, items.length);
  const chosen = new Set<number>();
  while (chosen.size < n) chosen.add(faker.number.int({ min: 0, max: items.length - 1 }));
  return [...chosen].map((i) => items[i]!);
}

function daysBack(faker: Faker, maxDays: number): Date {
  return new Date(REFERENCE_MS - faker.number.int({ min: 0, max: maxDays }) * DAY_MS);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildOrg(seed: number, index: number, size: SizeSpec, orgNames: NameBook, slugs: NameBook): WorldOrg {
  const faker = new Faker({ locale: [en, base] });
  faker.seed([seed, index]);

  let name = orgName(faker);
  for (let tries = 0; orgNames.has(name) && tries < 20; tries++) name = orgName(faker);
  name = orgNames.take(name);
  const slug = slugs.take(slugOf(name), (n) => String(n));
  const links: WorldLink[] = [];

  // Assets: a layered estate. Network devices and cloud services host servers; servers host
  // databases and run applications; endpoints stand alone.
  const types: AssetType[] = REQUIRED_TYPES.slice(0, size.assets);
  while (types.length < size.assets) types.push(faker.helpers.weightedArrayElement(TYPE_WEIGHTS));
  const shuffled = faker.helpers.shuffle(types);
  const assetNames = new NameBook();
  const assets: WorldRecord<'asset'>[] = shuffled.map((assetType, i) => {
    const classification = faker.helpers.weightedArrayElement(LABEL_WEIGHTS);
    return {
      key: keyOf('AST', i + 1),
      name: assetNames.take(assetName(slug, areaOf(faker), assetType, i + 1)),
      label: classification,
      assetType,
      criticality: faker.helpers.arrayElement(['low', 'medium', 'high', 'critical'] as const),
      dataClassification: classification,
    };
  });
  const ofTypes = (wanted: readonly AssetType[]) => assets.filter((a) => wanted.includes(a.assetType));
  const hosts = ofTypes(HOSTS_OF_SERVERS);
  const servers = ofTypes(['server']);
  if (hosts.length > 0) {
    for (const server of servers) {
      links.push({ type: 'HOSTS', fromKey: faker.helpers.arrayElement(hosts).key, toKey: server.key });
    }
  }
  if (servers.length > 0) {
    for (const database of ofTypes(['database'])) {
      links.push({ type: 'HOSTS', fromKey: faker.helpers.arrayElement(servers).key, toKey: database.key });
    }
    for (const app of ofTypes(['application'])) {
      for (const server of pickDistinct(faker, servers, faker.number.int({ min: 1, max: 2 }))) {
        links.push({ type: 'RUNS', fromKey: server.key, toKey: app.key });
      }
    }
  }

  // Policies, then controls each governed by one policy.
  const policyNames = new NameBook();
  const policies: WorldRecord<'policy'>[] = Array.from({ length: size.policies }, (_, i) => ({
    key: keyOf('POL', i + 1),
    name: policyNames.take(policyName(faker)),
    label: faker.helpers.arrayElement(['public', 'internal'] as const),
    policyVersion: `${faker.number.int({ min: 1, max: 4 })}.${faker.number.int({ min: 0, max: 9 })}`,
    effectiveDate: isoDay(daysBack(faker, 1095)),
  }));
  const controlNames = new NameBook();
  const controls: WorldRecord<'control'>[] = Array.from({ length: size.controls }, (_, i) => {
    const control = controlOf(faker, areaOf(faker));
    return {
      key: keyOf('CTL', i + 1),
      name: controlNames.take(control.name),
      label: faker.helpers.weightedArrayElement(LABEL_WEIGHTS),
      code: control.code,
      framework: control.framework,
      controlStatus: faker.helpers.weightedArrayElement([
        { value: 'implemented' as const, weight: 6 },
        { value: 'planned' as const, weight: 2 },
        { value: 'not_implemented' as const, weight: 1 },
      ]),
      lastTestedDate: isoDay(daysBack(faker, 540)),
    };
  });
  for (const control of controls) {
    links.push({ type: 'GOVERNED_BY', fromKey: control.key, toKey: faker.helpers.arrayElement(policies).key });
  }

  // Risks: each exposed through 1 to 3 assets and mitigated by 1 to 3 controls.
  const riskNames = new NameBook();
  const risks: WorldRecord<'risk'>[] = Array.from({ length: size.risks }, (_, i) => ({
    key: keyOf('RSK', i + 1),
    name: riskNames.take(riskName(faker, areaOf(faker))),
    label: faker.helpers.weightedArrayElement(LABEL_WEIGHTS),
    impact: faker.number.int({ min: 1, max: 5 }),
    likelihood: faker.number.int({ min: 1, max: 5 }),
    financialExposure: faker.number.int({ min: 10, max: 5000 }) * 1000,
  }));
  for (const risk of risks) {
    for (const asset of pickDistinct(faker, assets, faker.number.int({ min: 1, max: 3 }))) {
      links.push({ type: 'EXPOSED_TO', fromKey: asset.key, toKey: risk.key });
    }
    for (const control of pickDistinct(faker, controls, faker.number.int({ min: 1, max: 3 }))) {
      links.push({ type: 'MITIGATED_BY', fromKey: risk.key, toKey: control.key });
    }
  }

  // Incidents: each impacts 1 to 3 assets and exposes 0 to 2 risks.
  const incidentNames = new NameBook();
  const incidents: WorldRecord<'incident'>[] = [];
  for (let i = 0; i < size.incidents; i++) {
    const key = keyOf('INC', i + 1);
    const impacted = pickDistinct(faker, assets, faker.number.int({ min: 1, max: 3 }));
    const exposed = pickDistinct(faker, risks, faker.number.int({ min: 0, max: 2 }));
    const occurred = new Date(REFERENCE_MS - faker.number.int({ min: 1, max: 365 * 24 * 60 * 60 }) * 1000);
    incidents.push({
      key,
      name: incidentNames.take(incidentName(faker, impacted[0]!.name)),
      label: faker.helpers.weightedArrayElement(LABEL_WEIGHTS),
      severity: faker.helpers.weightedArrayElement([
        { value: 'low' as const, weight: 4 },
        { value: 'medium' as const, weight: 4 },
        { value: 'high' as const, weight: 2 },
        { value: 'critical' as const, weight: 1 },
      ]),
      incidentStatus: faker.helpers.arrayElement(['new', 'investigating', 'contained', 'resolved', 'closed'] as const),
      occurredAt: occurred.toISOString(),
    });
    for (const asset of impacted) links.push({ type: 'IMPACTS', fromKey: key, toKey: asset.key });
    for (const risk of exposed) links.push({ type: 'EXPOSES', fromKey: key, toKey: risk.key });
  }

  return {
    key: `ORG-${String(index + 1).padStart(2, '0')}`,
    name,
    assets,
    risks,
    controls,
    policies,
    incidents,
    links,
  };
}

/** The whole answer key: the same seed and size always give the same JSON (D45.8). */
export function buildWorld({ seed, size }: { seed: number; size: SizeSpec }): AnswerKey {
  checkSize(size);
  const orgNames = new NameBook();
  const slugs = new NameBook();
  const orgs = Array.from({ length: size.orgs }, (_, i) => buildOrg(seed, i, size, orgNames, slugs));
  return {
    generatorVersion: GENERATOR_VERSION,
    seed,
    size: { ...size },
    orgs,
  };
}
