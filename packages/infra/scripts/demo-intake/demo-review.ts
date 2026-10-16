// The fixed demo review findings for `pnpm seed:demo` (S5-007; D18, D24, D38, D42, D43, D50, D51,
// D52.5, D56, D69, D114, D45.5): per demo org, what processing would have left for the Analyst if
// Gemma had read the demo documents, as plain objects, the same on every run. Nothing here calls
// Gemma or bge-m3: seed-demo.ts stores these through S4's own rules, so they read like real
// processing output.
// - `records`: the few records the findings need that S1's demo data doesn't have (shape and
//   source IDs as in demo-records.ts, `demo:<key>`): a pair of assets with close spellings, the
//   possible duplicate, and in Acme a policy the live AI link points to.
// - `answers`: per uploaded demo document (its path, as in demo-intake.ts), the answer Gemma would
//   give (records with their names exactly as the document writes them, and links each with the
//   one sentence that states it, word for word), and what duplicate matching would make of each
//   name in the uploader's view: a clear match (by its step; a close meaning carries its cosine
//   score, the other two steps are scored by the seed as S4 scores them), an uncertain one with its
//   candidates, or none. A record is named by a source ID: a demo record's `demo:<key>`, or an
//   imported asset's `demo-cmdb:<sys_id>`. The seed runs S4's rule checks on these, so each link's
//   failed checks, finding key, label and live or waiting status are S4's, not written here. Only
//   the internal documents have answers: the demo Analyst's clearance is internal, and a finding
//   carries its document's label.
//   What they make, per org: a waiting link for each rule check (a sentence that doesn't name both
//   records, a wrong direction, an asset with 2 or 3 candidates), a SOC-ticket incident proposed
//   as a new record with the waiting link that points to it, and one live AI link.
// - `duplicates`: the pair of assets flagged as possibly one record (close spelling).
// - `mappings`: two suggested mappings, as S4-009 leaves them: a control SATISFIES an ISO 27001
//   requirement, and a SOC 2 criterion MAPS_TO a NIST 800-53 control, each with Gemma's short reason.
// - The two orgs' data differ, so the org wall is visible. docs/demo/s5.md walks through them.
import type { DemoRecord } from '../demo-records.js';

export type DemoReviewKind = 'asset' | 'risk' | 'control' | 'policy' | 'incident';

/** A record a name means: by its source ID, with the matching step that found it. */
export type DemoMatched =
  { record: string; step: 'exact' | 'spelling' } | { record: string; step: 'meaning'; score: number };

/** What duplicate matching made of a name (S4-007), in the uploader's view. */
export type DemoNameMatch =
  { outcome: 'clear'; match: DemoMatched } | { outcome: 'uncertain'; candidates: DemoMatched[] } | { outcome: 'none' };

/** A record of Gemma's answer: a short reference, its kind, its name as written, its details. */
export interface DemoAnswerRecord {
  ref: string;
  kind: DemoReviewKind;
  name: string;
  details?: Record<string, string>;
  match: DemoNameMatch;
}

/** A link of Gemma's answer: one of the 7 spec types, its two ends' references, its sentence. */
export interface DemoAnswerLink {
  type: 'HOSTS' | 'RUNS' | 'EXPOSED_TO' | 'MITIGATED_BY' | 'GOVERNED_BY' | 'IMPACTS' | 'EXPOSES';
  from: string;
  to: string;
  sentence: string;
}

/** Gemma's answer for one uploaded demo document, by its path under demo-intake/. */
export interface DemoDocumentAnswer {
  document: string;
  records: DemoAnswerRecord[];
  links: DemoAnswerLink[];
}

/** Two records of one kind that may be one, by their source IDs. */
export interface DemoDuplicate {
  kind: DemoReviewKind;
  a: string;
  b: string;
}

/** A requirement of a framework catalog, by its framework key and code. */
export interface DemoRequirementRef {
  framework: 'nist_800_53' | 'nist_csf_2' | 'iso_27001' | 'soc_2';
  code: string;
}

/** A suggested mapping: from a control (its source ID) or a requirement, to a requirement. */
export type DemoMappingSuggestion =
  | { type: 'SATISFIES'; control: string; to: DemoRequirementRef; reason: string }
  | { type: 'MAPS_TO'; from: DemoRequirementRef; to: DemoRequirementRef; reason: string };

export interface DemoReview {
  records: DemoRecord[];
  answers: DemoDocumentAnswer[];
  duplicates: DemoDuplicate[];
  mappings: DemoMappingSuggestion[];
}

const ACME: DemoReview = {
  records: [
    // The payroll team's shared mailbox, listed twice, once with a typo: a possible duplicate, and
    // the two candidates of the SOC ticket's "payroll team".
    {
      key: 'REV-AST-01',
      kind: 'asset',
      name: 'Payroll team mailbox',
      label: 'internal',
      owner: 'admin',
      fields: { assetType: 'application', criticality: 'medium', dataClassification: 'internal' },
    },
    {
      key: 'REV-AST-02',
      kind: 'asset',
      name: 'Payrol team mailbox',
      label: 'internal',
      owner: 'admin',
      fields: { assetType: 'application', criticality: 'medium', dataClassification: 'internal' },
    },
    // The policy the live AI link (a false positive) points to.
    {
      key: 'REV-POL-01',
      kind: 'policy',
      name: 'Remote Working Policy',
      label: 'internal',
      owner: 'compliance_manager',
      fields: { policyVersion: '1.2', effectiveDate: '2026-02-01' },
    },
  ],
  answers: [
    {
      // Uploaded by the Compliance Manager, internal.
      document: 'acme/acme-acceptable-use-standard.txt',
      records: [
        {
          ref: 'c1',
          kind: 'control',
          name: 'endpoint detection and response',
          match: { outcome: 'clear', match: { record: 'demo:CTL-02', step: 'exact' } },
        },
        {
          ref: 'p1',
          kind: 'policy',
          name: 'Information Security Policy',
          match: { outcome: 'clear', match: { record: 'demo:POL-01', step: 'exact' } },
        },
        {
          ref: 'c2',
          kind: 'control',
          name: 'multi-factor sign-in',
          match: { outcome: 'clear', match: { record: 'demo:CTL-01', step: 'meaning', score: 0.92 } },
        },
        {
          ref: 'p2',
          kind: 'policy',
          name: 'Remote access',
          match: { outcome: 'clear', match: { record: 'demo:REV-POL-01', step: 'meaning', score: 0.9 } },
        },
      ],
      links: [
        // Waits: the sentence doesn't name the policy.
        {
          type: 'GOVERNED_BY',
          from: 'c1',
          to: 'p1',
          sentence: 'Company laptops run endpoint detection and response at all times.',
        },
        // Live: every check passes, though the sentence only states a rule of this standard (the
        // false positive the Analyst removes).
        {
          type: 'GOVERNED_BY',
          from: 'c2',
          to: 'p2',
          sentence: 'Remote access to Acme systems requires multi-factor sign-in.',
        },
      ],
    },
    {
      // Uploaded by the Analyst, internal. INC-01 (confidential) is above the uploader's clearance,
      // so the ransomware ticket matches no incident and is proposed as a new one.
      document: 'acme/acme-soc-tickets-2026-09.json',
      records: [
        {
          ref: 'i1',
          kind: 'incident',
          name: 'Ransomware behaviour blocked by endpoint detection on the build server',
          details: { ticket: 'SOC-4471', opened: '2026-09-03T08:14:00Z', severity: 'high', status: 'closed' },
          match: { outcome: 'none' },
        },
        {
          ref: 'a1',
          kind: 'asset',
          name: 'build server',
          match: { outcome: 'clear', match: { record: 'demo:AST-06', step: 'exact' } },
        },
        {
          ref: 'i2',
          kind: 'incident',
          name: 'phishing email',
          match: { outcome: 'clear', match: { record: 'demo:INC-02', step: 'meaning', score: 0.91 } },
        },
        {
          ref: 'r1',
          kind: 'risk',
          name: 'phishing',
          match: { outcome: 'clear', match: { record: 'demo:RSK-05', step: 'meaning', score: 0.9 } },
        },
        {
          ref: 'a2',
          kind: 'asset',
          name: 'payroll team',
          match: {
            outcome: 'uncertain',
            candidates: [
              { record: 'demo:REV-AST-01', step: 'meaning', score: 0.87 },
              { record: 'demo:REV-AST-02', step: 'meaning', score: 0.86 },
            ],
          },
        },
      ],
      links: [
        // Waits on the proposed incident.
        {
          type: 'IMPACTS',
          from: 'i1',
          to: 'a1',
          sentence: 'Ransomware behaviour blocked by endpoint detection on the build server',
        },
        // Waits: two mailboxes may be the payroll team's.
        {
          type: 'IMPACTS',
          from: 'i2',
          to: 'a2',
          sentence: 'Staff member reported a phishing email impersonating the payroll team',
        },
        // Waits: the wrong direction (an incident exposes a risk, never the other way).
        {
          type: 'EXPOSES',
          from: 'r1',
          to: 'i2',
          sentence: 'Staff member reported a phishing email impersonating the payroll team',
        },
      ],
    },
  ],
  duplicates: [{ kind: 'asset', a: 'demo:REV-AST-01', b: 'demo:REV-AST-02' }],
  mappings: [
    {
      type: 'SATISFIES',
      control: 'demo:CTL-07',
      to: { framework: 'iso_27001', code: 'A.8.9' },
      reason:
        'The control watches cloud settings against a secure baseline, which is what A.8.9 asks for: secure configurations that are set, recorded, monitored and reviewed.',
    },
    {
      type: 'MAPS_TO',
      from: { framework: 'soc_2', code: 'CC6.6' },
      to: { framework: 'nist_800_53', code: 'SC-7' },
      reason:
        'Both protect the system at its outer edge: CC6.6 asks for measures against threats from outside the boundary, and SC-7 monitors and controls communications at that boundary.',
    },
  ],
};

const GLOBEX: DemoReview = {
  records: [
    // The depot's pool of spare scanners, listed twice, once with a typo: a possible duplicate, and
    // two of the three candidates of the standard's "scanner".
    {
      key: 'REV-AST-01',
      kind: 'asset',
      name: 'Spare scanner pool',
      label: 'internal',
      owner: 'admin',
      fields: { assetType: 'endpoint', criticality: 'medium', dataClassification: 'internal' },
    },
    {
      key: 'REV-AST-02',
      kind: 'asset',
      name: 'Spare scaner pool',
      label: 'internal',
      owner: 'admin',
      fields: { assetType: 'endpoint', criticality: 'medium', dataClassification: 'internal' },
    },
  ],
  answers: [
    {
      // Uploaded by the Compliance Manager, internal.
      document: 'globex/globex-driver-device-standard.txt',
      records: [
        {
          ref: 'c1',
          kind: 'control',
          name: 'mobile device management',
          match: { outcome: 'clear', match: { record: 'demo:CTL-01', step: 'meaning', score: 0.93 } },
        },
        {
          ref: 'p1',
          kind: 'policy',
          name: 'Mobile Device Policy',
          match: { outcome: 'clear', match: { record: 'demo:POL-02', step: 'exact' } },
        },
        {
          ref: 'a1',
          kind: 'asset',
          name: 'scanner',
          match: {
            outcome: 'uncertain',
            candidates: [
              { record: 'demo:AST-07', step: 'meaning', score: 0.87 },
              { record: 'demo:REV-AST-01', step: 'meaning', score: 0.85 },
              { record: 'demo:REV-AST-02', step: 'meaning', score: 0.84 },
            ],
          },
        },
        {
          ref: 'r1',
          kind: 'risk',
          name: 'lost or stolen scanner',
          match: { outcome: 'clear', match: { record: 'demo:RSK-04', step: 'meaning', score: 0.94 } },
        },
        {
          ref: 'a2',
          kind: 'asset',
          name: 'device',
          match: { outcome: 'clear', match: { record: 'demo:AST-07', step: 'meaning', score: 0.9 } },
        },
        {
          ref: 'a3',
          kind: 'asset',
          name: 'Delivery photos',
          match: { outcome: 'clear', match: { record: 'demo-cmdb:CMDB-2006', step: 'meaning', score: 0.93 } },
        },
      ],
      links: [
        // Waits: the sentence doesn't name the policy.
        {
          type: 'GOVERNED_BY',
          from: 'c1',
          to: 'p1',
          sentence: 'Every scanner is enrolled in mobile device management before it leaves the depot.',
        },
        // Waits: three assets may be the scanner meant.
        {
          type: 'EXPOSED_TO',
          from: 'a1',
          to: 'r1',
          sentence: 'A lost or stolen scanner is reported to the depot supervisor straight away.',
        },
        // Live: every check passes, though the sentence says the photos are NOT kept on the
        // device (the false positive the Analyst removes).
        {
          type: 'HOSTS',
          from: 'a2',
          to: 'a3',
          sentence:
            'Delivery photos and signatures are uploaded at the end of each stop and are not kept on the device.',
        },
      ],
    },
    {
      // Uploaded by the Analyst, internal. INC-03 (confidential) is above the uploader's clearance,
      // so the VPN ticket matches no incident and is proposed as a new one.
      document: 'globex/globex-soc-tickets-2026-09.json',
      records: [
        {
          ref: 'i1',
          kind: 'incident',
          name: 'VPN sign-ins for one driver account from two countries within an hour',
          details: { ticket: 'GSOC-0912', opened: '2026-09-05T06:20:00Z', severity: 'medium', status: 'closed' },
          match: { outcome: 'none' },
        },
        {
          ref: 'a1',
          kind: 'asset',
          name: 'VPN',
          match: { outcome: 'clear', match: { record: 'demo:AST-11', step: 'meaning', score: 0.91 } },
        },
        {
          ref: 'i2',
          kind: 'incident',
          name: 'Malware quarantined on a dispatch office PC',
          match: { outcome: 'clear', match: { record: 'demo:INC-05', step: 'meaning', score: 0.92 } },
        },
        {
          ref: 'a2',
          kind: 'asset',
          name: 'dispatch office PC',
          match: { outcome: 'clear', match: { record: 'demo:AST-12', step: 'spelling' } },
        },
      ],
      links: [
        // Waits on the proposed incident.
        {
          type: 'IMPACTS',
          from: 'i1',
          to: 'a1',
          sentence: 'VPN sign-ins for one driver account from two countries within an hour',
        },
        // Waits: the wrong direction (an incident impacts an asset, never the other way).
        {
          type: 'IMPACTS',
          from: 'a2',
          to: 'i2',
          sentence: 'Malware quarantined on a dispatch office PC',
        },
      ],
    },
  ],
  duplicates: [{ kind: 'asset', a: 'demo:REV-AST-01', b: 'demo:REV-AST-02' }],
  mappings: [
    {
      type: 'SATISFIES',
      control: 'demo:CTL-10',
      to: { framework: 'iso_27001', code: 'A.8.16' },
      reason:
        'Uptime monitoring and alerting watches systems for unusual behaviour and raises alerts, which is what A.8.16 asks for: monitor networks, systems and applications and act on what is found.',
    },
    {
      type: 'MAPS_TO',
      from: { framework: 'soc_2', code: 'CC7.4' },
      to: { framework: 'nist_800_53', code: 'IR-4' },
      reason:
        'Both ask for a set way to handle security incidents: CC7.4 a response programme to contain, fix and communicate about them, and IR-4 an incident handling capability.',
    },
  ],
};

/** Each demo org's review findings, by the org's base slug (as DEMO_INTAKE). */
export const DEMO_REVIEW: Record<string, DemoReview> = {
  'demo-acme': ACME,
  'demo-globex': GLOBEX,
};
