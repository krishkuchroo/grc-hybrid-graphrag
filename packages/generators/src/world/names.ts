// Believable canonical names for the world's orgs and records. Every name comes from the org's own
// seeded faker, so the same seed always gives the same names.
import type { Faker } from '@faker-js/faker';
import type { AssetType } from '@grc/shared';

/** Business areas an asset, risk or control can belong to. */
export const AREAS = [
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
] as const;

const ASSET_SUFFIX: Record<AssetType, string> = {
  server: 'srv',
  application: 'app',
  database: 'db',
  network_device: 'fw',
  cloud_service: 'cloud',
  endpoint: 'ws',
};

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
] as const;

const CONTROL_CATALOG: readonly (readonly [string, string, string])[] = [
  ['NIST 800-53', 'AC-2', 'Account Management'],
  ['NIST 800-53', 'AC-6', 'Least Privilege'],
  ['NIST 800-53', 'AU-6', 'Audit Record Review'],
  ['NIST 800-53', 'CM-6', 'Configuration Settings'],
  ['NIST 800-53', 'CP-9', 'System Backup'],
  ['NIST 800-53', 'IA-2', 'Multi-Factor Authentication'],
  ['NIST 800-53', 'IR-4', 'Incident Handling'],
  ['NIST 800-53', 'RA-5', 'Vulnerability Scanning'],
  ['NIST 800-53', 'SC-7', 'Boundary Protection'],
  ['NIST 800-53', 'SC-13', 'Cryptographic Protection'],
  ['NIST 800-53', 'SI-2', 'Flaw Remediation'],
  ['NIST 800-53', 'SI-4', 'System Monitoring'],
  ['CSF 2.0', 'PR.AA-01', 'Identity Management'],
  ['CSF 2.0', 'PR.DS-01', 'Data-at-Rest Protection'],
  ['CSF 2.0', 'DE.CM-01', 'Network Monitoring'],
  ['CSF 2.0', 'RS.MA-01', 'Incident Response Execution'],
  ['ISO 27001', 'A.8.13', 'Information Backup'],
  ['ISO 27001', 'A.5.15', 'Access Control'],
  ['SOC 2', 'CC6.1', 'Logical Access Security'],
  ['SOC 2', 'CC7.2', 'Security Event Monitoring'],
];

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
] as const;

/** Hands out names that are unique within one set: a repeat gets " (2)", " (3)" … */
export class NameBook {
  private readonly seen = new Set<string>();

  has(name: string): boolean {
    return this.seen.has(name);
  }

  take(name: string, suffix: (n: number) => string = (n) => ` (${n})`): string {
    let candidate = name;
    for (let n = 2; this.seen.has(candidate); n++) candidate = `${name}${suffix(n)}`;
    this.seen.add(candidate);
    return candidate;
  }
}

/** A short lowercase slug of an org name, for its asset host names. */
export function slugOf(orgName: string): string {
  const first = orgName.split(/[^A-Za-z]+/).find((word) => word.length > 0) ?? 'org';
  return first.toLowerCase().slice(0, 10);
}

export function orgName(faker: Faker): string {
  return faker.company.name();
}

export function areaOf(faker: Faker): string {
  return faker.helpers.arrayElement(AREAS);
}

/** A host-style asset name, unique through its number: `acme-billing-db-0042`. */
export function assetName(slug: string, area: string, type: AssetType, index: number): string {
  return `${slug}-${area}-${ASSET_SUFFIX[type]}-${String(index).padStart(4, '0')}`;
}

export function riskName(faker: Faker, area: string): string {
  return `${faker.helpers.arrayElement(THREATS)} in ${area} systems`;
}

export function controlOf(faker: Faker, area: string): { name: string; code: string; framework: string } {
  const [framework, code, title] = faker.helpers.arrayElement(CONTROL_CATALOG);
  return { name: `${title} for ${area}`, code, framework };
}

export function policyName(faker: Faker): string {
  return `${faker.helpers.arrayElement(POLICY_TOPICS)} Policy`;
}

export function incidentName(faker: Faker, assetName: string): string {
  return `${faker.helpers.arrayElement(INCIDENT_KINDS)} on ${assetName}`;
}
