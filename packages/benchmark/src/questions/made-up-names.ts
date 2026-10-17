// Made-up record names for `no_answer` questions (S8-003): in the same style as the generator's names
// (packages/generators/src/world/names.ts), so a question about one reads like a real question, but
// matching no record of the org.
// - asset: `<org's host prefix>-<area>-<srv|app|db|fw|cloud|ws>-<4 digits>`
// - risk: `<threat> in <area> systems`
// - control: `<control title> for <area>`
// - policy: `<topic> Policy`
// - incident: `<incident kind> on <a made-up asset name>`
// A name counts as made up when, after S4's `normaliseName`, it is no record's name and neither it
// nor any record's name holds the other as whole words, so no record is named by the question.
// Every choice comes from the faker it is given (D33, D45.8).
import type { Faker } from '@faker-js/faker';
import type { RecordKind } from '@grc/shared';
import { normaliseName } from '@grc/shared';
import type { GraphRecord } from './org-graph.js';

const AREAS = [
  'billing',
  'payments',
  'payroll',
  'crm',
  'hr',
  'erp',
  'identity',
  'logistics',
  'analytics',
  'support',
  'marketing',
  'finance',
  'claims',
  'inventory',
  'reporting',
  'backup',
  'email',
  'web',
  'procurement',
  'treasury',
  'legal',
  'sales',
  'research',
  'facilities',
] as const;

const ASSET_SUFFIXES = ['srv', 'app', 'db', 'fw', 'cloud', 'ws'] as const;

const THREATS = [
  'Ransomware encryption',
  'Unauthorised access',
  'Data exfiltration',
  'Credential theft',
  'Service outage',
  'Unpatched vulnerabilities',
  'Insider misuse',
  'Misconfiguration',
  'Third-party compromise',
  'Denial of service',
  'Data loss',
  'Privilege escalation',
  'Phishing compromise',
  'Weak encryption',
  'Backup failure',
  'Supply chain tampering',
  'Session hijacking',
  'Shadow IT adoption',
] as const;

const CONTROL_TITLES = [
  'Account Management',
  'Least Privilege',
  'Audit Record Review',
  'Configuration Settings',
  'System Backup',
  'Multi-Factor Authentication',
  'Incident Handling',
  'Vulnerability Scanning',
  'Boundary Protection',
  'Cryptographic Protection',
  'Flaw Remediation',
  'System Monitoring',
  'Identity Management',
  'Data-at-Rest Protection',
  'Network Monitoring',
  'Incident Response Execution',
  'Information Backup',
  'Access Control',
  'Logical Access Security',
  'Security Event Monitoring',
  'Media Sanitisation',
  'Session Lock',
] as const;

const POLICY_TOPICS = [
  'Information Security',
  'Acceptable Use',
  'Access Control',
  'Data Classification',
  'Incident Response',
  'Business Continuity',
  'Backup and Recovery',
  'Change Management',
  'Vendor Risk Management',
  'Encryption',
  'Password',
  'Remote Work',
  'Vulnerability Management',
  'Logging and Monitoring',
  'Data Retention',
  'Secure Development',
  'Physical Security',
  'Asset Management',
  'Network Security',
  'Privacy',
  'Clean Desk',
  'Mobile Device',
  'Cloud Security',
  'Records Management',
] as const;

const INCIDENT_KINDS = [
  'Malware detected',
  'Suspicious login',
  'Phishing email reported',
  'Unplanned outage',
  'Data leak suspected',
  'Brute-force attempt',
  'Unauthorised change',
  'Certificate expired',
  'Port scan detected',
  'Lost laptop',
  'Disk failure',
  'Expired account used',
] as const;

/** The host prefix of the org's asset names: the most used first part of `<prefix>-<area>-<type>-<n>`. */
export function assetPrefixOf(orgName: string, records: readonly GraphRecord[]): string {
  const uses = new Map<string, number>();
  for (const record of records) {
    if (record.kind !== 'asset') continue;
    const match = /^([a-z0-9]+)-[a-z0-9]+-[a-z0-9]+-\d+$/.exec(record.name);
    if (match) uses.set(match[1]!, (uses.get(match[1]!) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [prefix, n] of uses) if (best === null || n > uses.get(best)!) best = prefix;
  if (best !== null) return best;
  // As the generator makes it: the org name's first word, lowercase, at most 10 letters.
  const first = orgName.split(/[^A-Za-z]+/).find((word) => word.length > 0) ?? 'org';
  return first.toLowerCase().slice(0, 10);
}

function madeUpAsset(faker: Faker, prefix: string): string {
  const area = faker.helpers.arrayElement(AREAS);
  const suffix = faker.helpers.arrayElement(ASSET_SUFFIXES);
  const n = String(faker.number.int({ min: 1, max: 9999 })).padStart(4, '0');
  return `${prefix}-${area}-${suffix}-${n}`;
}

/** One candidate name of the kind's style (not yet checked against the org's names). */
export function madeUpName(faker: Faker, kind: RecordKind, assetPrefix: string): string {
  switch (kind) {
    case 'asset':
      return madeUpAsset(faker, assetPrefix);
    case 'risk':
      return `${faker.helpers.arrayElement(THREATS)} in ${faker.helpers.arrayElement(AREAS)} systems`;
    case 'control':
      return `${faker.helpers.arrayElement(CONTROL_TITLES)} for ${faker.helpers.arrayElement(AREAS)}`;
    case 'policy':
      return `${faker.helpers.arrayElement(POLICY_TOPICS)} Policy`;
    case 'incident':
      return `${faker.helpers.arrayElement(INCIDENT_KINDS)} on ${madeUpAsset(faker, assetPrefix)}`;
  }
}

/** Whether `inner` is `outer`'s words or a whole-word run of them (both normalised). */
function holdsWords(outer: string, inner: string): boolean {
  return ` ${outer} `.includes(` ${inner} `);
}

/**
 * Whether the name is made up for the org: not empty after normalising, no record's name, and
 * neither it nor any record's name holds the other as whole words.
 */
export function isMadeUp(name: string, records: readonly GraphRecord[]): boolean {
  const n = normaliseName(name);
  if (n === '') return false;
  return records.every((r) => r.normalised === '' || (!holdsWords(n, r.normalised) && !holdsWords(r.normalised, n)));
}
