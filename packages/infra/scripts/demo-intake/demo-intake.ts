// The fixed demo intake for `pnpm seed:demo` (S3-020, D114, D45.5, D45.8, D213 (2)-(6)): per demo
// org, the files it uploads, its asset import, its evidence and its audit findings, as plain objects,
// the same on every run. The files themselves sit next to this module (`acme/`, `globex/`), so
// their contents, and with them their content hashes, never change.
// - The asset list is uploaded as the org's Admin from the fixed source `demo-cmdb`, then imported
//   with the mapping below, which is saved for the source. Its rows are new assets (an import matches
//   only on `<source>:<source ID>`, so S1's demo assets are never duplicated), linked to each other
//   by HOSTS and RUNS.
// - The other documents (two policy documents and one SOC ticket file per org) are uploaded by the
//   role named, a role that may upload that kind (D50).
// - Evidence is named by the demo control it supports (its S1 key, `demo:<key>` as source ID). On a
//   control the demo Control Owner owns: one item the Control Owner adds and one the Admin adds,
//   both at a label the Control Owner's `internal` clearance sees; the Admin's item there expires
//   within 30 days of the first run (`validForDays`). A third item sits on another control.
// - Audit findings are added by the Auditor (the only role that edits them, D50), each with its
//   CONCERNS link to a demo control or risk the Auditor sees. Every D213 (2) field is filled: one
//   `open` and overdue, one `risk_accepted`, one `closed` with its closed date. Each one's
//   `sourceReference` is unique in its org and finds it again on a re-run.
// - Dates are fixed and in the past, but for the expiring evidence's valid-until date, which is
//   counted from the day of the run that adds it.
// - The `walkthrough/` files are for the click-through in docs/demo/s3.md; the seed never loads them.
// - The two orgs' data differ, so the org wall is visible.
import { readFileSync } from 'node:fs';

export type DemoIntakeRole = 'admin' | 'risk_manager' | 'compliance_manager' | 'control_owner' | 'auditor' | 'analyst';
export type DemoIntakeLabel = 'public' | 'internal' | 'confidential' | 'restricted';

/** The asset list: uploaded by the Admin, then imported with `mapping` (saved for `source`). */
export interface DemoAssetList {
  file: string;
  source: string;
  label: DemoIntakeLabel;
  /** Our field -> the file's column. */
  mapping: {
    sourceId: string;
    name: string;
    assetType?: string;
    criticality?: string;
    dataClassification?: string;
    owner?: string;
    hostedOn?: string;
    runsOn?: string;
  };
}

/** A document upload other than the asset list. */
export interface DemoDocument {
  kind: 'policy_document' | 'soc_ticket' | 'audit_report';
  file: string;
  label: DemoIntakeLabel;
  uploader: DemoIntakeRole;
}

/** An evidence item on a demo control. */
export interface DemoEvidence {
  /** The S1 key of the control it supports (`CTL-01`). */
  control: string;
  addedBy: 'admin' | 'control_owner';
  file: string;
  name: string;
  collectedDate: string;
  /** A fixed last valid day, or a number of days from the run's date; none when it doesn't expire. */
  validUntil?: string;
  validForDays?: number;
  label: DemoIntakeLabel;
}

/** An audit finding, added by the Auditor, concerning a demo control or risk. */
export interface DemoFinding {
  /** The S1 key of the control or risk it concerns (`CTL-02`, `RSK-03`). */
  concerns: string;
  name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  findingStatus: 'open' | 'in_progress' | 'remediated' | 'risk_accepted' | 'closed';
  owner: DemoIntakeRole;
  /** Unique in its org: a re-run finds the finding by it. */
  sourceReference: string;
  rootCause: string;
  remediationPlan: string;
  identifiedDate: string;
  dueDate: string;
  closedDate?: string;
  description: string;
  label: DemoIntakeLabel;
}

export interface DemoIntake {
  assetList: DemoAssetList;
  documents: DemoDocument[];
  evidence: DemoEvidence[];
  findings: DemoFinding[];
}

/** The CMDB export's columns, the same in both orgs' files. */
const CMDB_MAPPING: DemoAssetList['mapping'] = {
  sourceId: 'sys_id',
  name: 'name',
  assetType: 'sys_class_name',
  criticality: 'u_criticality',
  dataClassification: 'data_classification',
  owner: 'owner_email',
  hostedOn: 'hosted_on',
  runsOn: 'runs_on',
};

/** The source both orgs' asset lists come from. */
export const DEMO_ASSET_SOURCE = 'demo-cmdb';

const ACME: DemoIntake = {
  assetList: { file: 'acme/acme-cmdb-export.csv', source: DEMO_ASSET_SOURCE, label: 'internal', mapping: CMDB_MAPPING },
  documents: [
    {
      kind: 'policy_document',
      file: 'acme/acme-acceptable-use-standard.txt',
      label: 'internal',
      uploader: 'compliance_manager',
    },
    {
      kind: 'policy_document',
      file: 'acme/acme-incident-response-plan.txt',
      label: 'confidential',
      uploader: 'compliance_manager',
    },
    { kind: 'soc_ticket', file: 'acme/acme-soc-tickets-2026-09.json', label: 'internal', uploader: 'analyst' },
  ],
  evidence: [
    // CTL-01 Multi-factor sign-in for remote access: the Control Owner's own control (internal).
    {
      control: 'CTL-01',
      addedBy: 'control_owner',
      file: 'acme/acme-mfa-enrolment-report.csv',
      name: 'MFA enrolment report, September 2026',
      collectedDate: '2026-09-29',
      label: 'internal',
    },
    {
      control: 'CTL-01',
      addedBy: 'admin',
      file: 'acme/acme-vpn-mfa-settings-export.json',
      name: 'VPN gateway MFA settings export',
      collectedDate: '2026-09-15',
      validForDays: 21,
      label: 'internal',
    },
    // CTL-05 Encrypted backups with an offline copy: the Compliance Manager's (confidential).
    {
      control: 'CTL-05',
      addedBy: 'admin',
      file: 'acme/acme-backup-restore-test-2026-q3.txt',
      name: 'Backup restore test, Q3 2026',
      collectedDate: '2026-09-08',
      validUntil: '2027-03-31',
      label: 'confidential',
    },
  ],
  findings: [
    {
      concerns: 'CTL-01',
      name: 'Contractor VPN accounts not removed when contracts end',
      severity: 'high',
      findingStatus: 'open',
      owner: 'control_owner',
      sourceReference: 'Acme internal audit IA-2026-07, item 3',
      rootCause: 'Contract end dates are not sent to the team that manages VPN accounts.',
      remediationPlan: 'Disable VPN accounts automatically on the contract end date, and review them every quarter.',
      identifiedDate: '2026-07-21',
      dueDate: '2026-09-30',
      description: 'Four of 27 contractor VPN accounts sampled belonged to contracts that had already ended.',
      label: 'internal',
    },
    {
      concerns: 'RSK-03',
      name: 'Edge firewall firmware two releases behind',
      severity: 'medium',
      findingStatus: 'risk_accepted',
      owner: 'risk_manager',
      sourceReference: 'Acme internal audit IA-2026-07, item 5',
      rootCause: 'The vendor release needs a maintenance window the production network cannot give before year end.',
      remediationPlan: 'Upgrade in the January 2027 window; until then, extra intrusion signatures stay on.',
      identifiedDate: '2026-07-23',
      dueDate: '2027-01-31',
      description: 'The Risk Manager accepted the risk until the January 2027 maintenance window.',
      label: 'internal',
    },
    {
      concerns: 'CTL-05',
      name: 'Backup restore tests not recorded',
      severity: 'low',
      findingStatus: 'closed',
      owner: 'compliance_manager',
      sourceReference: 'Acme SOC 2 readiness review 2026, item 11',
      rootCause: 'Restore tests ran, but their results were kept only in the operators’ chat channel.',
      remediationPlan: 'Record every restore test on a fixed template and attach it as evidence on the backup control.',
      identifiedDate: '2026-05-19',
      dueDate: '2026-08-31',
      closedDate: '2026-09-12',
      description: 'Closed after the Q3 restore test was recorded and attached as evidence.',
      label: 'confidential',
    },
  ],
};

const GLOBEX: DemoIntake = {
  assetList: {
    file: 'globex/globex-cmdb-export.csv',
    source: DEMO_ASSET_SOURCE,
    label: 'internal',
    mapping: CMDB_MAPPING,
  },
  documents: [
    {
      kind: 'policy_document',
      file: 'globex/globex-driver-device-standard.txt',
      label: 'internal',
      uploader: 'compliance_manager',
    },
    {
      kind: 'policy_document',
      file: 'globex/globex-business-continuity-runbook.txt',
      label: 'confidential',
      uploader: 'compliance_manager',
    },
    { kind: 'soc_ticket', file: 'globex/globex-soc-tickets-2026-09.json', label: 'internal', uploader: 'analyst' },
  ],
  evidence: [
    // CTL-01 Mobile device management for scanners: the Control Owner's own control (internal).
    {
      control: 'CTL-01',
      addedBy: 'control_owner',
      file: 'globex/globex-mdm-enrolment-report.csv',
      name: 'Scanner MDM enrolment report, September 2026',
      collectedDate: '2026-09-28',
      label: 'internal',
    },
    {
      control: 'CTL-01',
      addedBy: 'admin',
      file: 'globex/globex-mdm-compliance-policy-export.json',
      name: 'Scanner MDM compliance policy export',
      collectedDate: '2026-09-20',
      validForDays: 21,
      label: 'internal',
    },
    // CTL-08 Encryption of tracking data at rest: the Compliance Manager's (confidential).
    {
      control: 'CTL-08',
      addedBy: 'admin',
      file: 'globex/globex-tracking-encryption-settings.txt',
      name: 'Tracking database encryption settings',
      collectedDate: '2026-09-22',
      validUntil: '2027-09-01',
      label: 'confidential',
    },
  ],
  findings: [
    {
      concerns: 'CTL-02',
      name: 'VPN accounts of former drivers still active',
      severity: 'high',
      findingStatus: 'open',
      owner: 'control_owner',
      sourceReference: 'Globex internal audit GA-2026-06, item 2',
      rootCause: 'Leavers are removed from payroll, but nobody tells the VPN team.',
      remediationPlan: 'Link the leavers process to the VPN directory and disable accounts on the last working day.',
      identifiedDate: '2026-06-30',
      dueDate: '2026-09-15',
      description: 'Six VPN accounts belonged to drivers who had left more than 30 days earlier.',
      label: 'internal',
    },
    {
      concerns: 'RSK-04',
      name: 'Older scanners cannot be wiped remotely',
      severity: 'medium',
      findingStatus: 'risk_accepted',
      owner: 'risk_manager',
      sourceReference: 'Globex internal audit GA-2026-06, item 4',
      rootCause: 'Scanners bought before 2023 run a version the device management service no longer supports.',
      remediationPlan: 'Replace the 40 older scanners in the 2027 hardware refresh; until then they hold no photos.',
      identifiedDate: '2026-07-02',
      dueDate: '2027-04-30',
      description: 'The Risk Manager accepted the risk until the 2027 hardware refresh.',
      label: 'internal',
    },
    {
      concerns: 'CTL-08',
      name: 'Tracking data encryption key not rotated in 2025',
      severity: 'medium',
      findingStatus: 'closed',
      owner: 'compliance_manager',
      sourceReference: 'Globex ISO 27001 surveillance audit 2026, item 7',
      rootCause: 'The yearly key rotation was a manual task with no reminder.',
      remediationPlan: 'Turn on automatic yearly rotation in the key vault and keep its log as evidence.',
      identifiedDate: '2026-04-14',
      dueDate: '2026-09-30',
      closedDate: '2026-09-02',
      description: 'Closed once automatic rotation was on and the key had been rotated.',
      label: 'confidential',
    },
  ],
};

/** Each demo org's intake, by the org's base slug. */
export const DEMO_INTAKE: Record<string, DemoIntake> = {
  'demo-acme': ACME,
  'demo-globex': GLOBEX,
};

const HERE = new URL('./', import.meta.url);

/** The bytes of one of the fixed files, by its path under this folder. */
export function demoIntakeFile(path: string): Buffer {
  return readFileSync(new URL(path, HERE));
}

/** The last day a dated item is valid, `YYYY-MM-DD`: fixed, or counted from `today`; null when none. */
export function demoValidUntil(item: Pick<DemoEvidence, 'validUntil' | 'validForDays'>, today: string): string | null {
  if (item.validUntil !== undefined) return item.validUntil;
  if (item.validForDays === undefined) return null;
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + item.validForDays);
  return day.toISOString().slice(0, 10);
}
