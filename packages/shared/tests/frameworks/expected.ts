// The expected framework facts for S2-001, written out by hand from TASKS.md (S2 shared notes, the
// S2-001 brief) and memory.md (D20, D212), NOT imported from src, so the tests check the code against
// the plan rather than against itself.

export const KEYS = ['nist_800_53', 'nist_csf_2', 'iso_27001', 'soc_2'] as const;
export type Key = (typeof KEYS)[number];

/** The shared notes' table: name shown, frameworkVersion, publisher. */
export const TABLE: Record<Key, { name: string; frameworkVersion: string; publisher: string }> = {
  nist_800_53: { name: 'NIST SP 800-53', frameworkVersion: 'Rev. 5', publisher: 'NIST' },
  nist_csf_2: { name: 'NIST Cybersecurity Framework', frameworkVersion: '2.0', publisher: 'NIST' },
  iso_27001: { name: 'ISO/IEC 27001', frameworkVersion: '2022', publisher: 'ISO/IEC' },
  soc_2: {
    name: 'SOC 2 Trust Services Criteria',
    frameworkVersion: '2017 (revised points of focus 2022)',
    publisher: 'AICPA',
  },
};

/** Every group code per framework: 20 families, 22 CSF categories, 4 ISO themes, and the SOC 2
 * series CC1-CC9, A1, C1, PI1, P1-P8 (the brief's list, 20 series). */
export const GROUPS: Record<Key, readonly string[]> = {
  nist_800_53: [
    'AC',
    'AT',
    'AU',
    'CA',
    'CM',
    'CP',
    'IA',
    'IR',
    'MA',
    'MP',
    'PE',
    'PL',
    'PM',
    'PS',
    'PT',
    'RA',
    'SA',
    'SC',
    'SI',
    'SR',
  ],
  nist_csf_2: [
    'GV.OC',
    'GV.RM',
    'GV.RR',
    'GV.PO',
    'GV.OV',
    'GV.SC',
    'ID.AM',
    'ID.RA',
    'ID.IM',
    'PR.AA',
    'PR.AT',
    'PR.DS',
    'PR.PS',
    'PR.IR',
    'DE.CM',
    'DE.AE',
    'RS.MA',
    'RS.AN',
    'RS.CO',
    'RS.MI',
    'RC.RP',
    'RC.CO',
  ],
  iso_27001: ['A.5', 'A.6', 'A.7', 'A.8'],
  soc_2: [
    'CC1',
    'CC2',
    'CC3',
    'CC4',
    'CC5',
    'CC6',
    'CC7',
    'CC8',
    'CC9',
    'A1',
    'C1',
    'PI1',
    'P1',
    'P2',
    'P3',
    'P4',
    'P5',
    'P6',
    'P7',
    'P8',
  ],
};

/** Group names the plan spells out exactly. */
export const NAMED_GROUPS: [Key, string, string][] = [
  ['nist_800_53', 'AC', 'Access Control'],
  ['nist_csf_2', 'GV.OC', 'Organizational Context'],
  ['iso_27001', 'A.5', 'Organizational controls'],
  ['iso_27001', 'A.6', 'People controls'],
  ['iso_27001', 'A.7', 'Physical controls'],
  ['iso_27001', 'A.8', 'Technological controls'],
  ['soc_2', 'CC6', 'Logical and Physical Access Controls'],
];

/** Valid sample codes (criterion 2), each with its group and parent code (criterion 3). */
export const SAMPLES: [Key, string, string, string | null][] = [
  ['nist_800_53', 'AC-2', 'AC', null],
  ['nist_800_53', 'AC-2(1)', 'AC', 'AC-2'],
  ['nist_800_53', 'SI-4(24)', 'SI', 'SI-4'],
  ['nist_800_53', 'AC-10', 'AC', null],
  ['nist_800_53', 'SR-12', 'SR', null],
  ['nist_800_53', 'PT-2(2)', 'PT', 'PT-2'],
  ['nist_csf_2', 'GV.OC-01', 'GV.OC', null],
  ['nist_csf_2', 'PR.AA-05', 'PR.AA', null],
  ['nist_csf_2', 'RC.CO-04', 'RC.CO', null],
  ['nist_csf_2', 'DE.AE-02', 'DE.AE', null],
  ['iso_27001', 'A.5.1', 'A.5', null],
  ['iso_27001', 'A.8.34', 'A.8', null],
  ['iso_27001', 'A.6.8', 'A.6', null],
  ['iso_27001', 'A.7.14', 'A.7', null],
  ['soc_2', 'CC6.1', 'CC6', null],
  ['soc_2', 'CC1.1', 'CC1', null],
  ['soc_2', 'PI1.5', 'PI1', null],
  ['soc_2', 'P8.1', 'P8', null],
  ['soc_2', 'A1.3', 'A1', null],
  ['soc_2', 'C1.2', 'C1', null],
];

export const ROLES = [
  'admin',
  'risk_manager',
  'compliance_manager',
  'control_owner',
  'auditor',
  'analyst',
  'viewer',
] as const;
export const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;

/** D212 (3): the only roles whose "Framework mappings" cell is `edit` (D50). */
export const MAPPERS: readonly string[] = ['admin', 'compliance_manager'];

/** Clearance at or above the label (D51). */
export function atOrBelow(label: string, clearance: string): boolean {
  const l = (LABELS as readonly string[]).indexOf(label);
  const c = (LABELS as readonly string[]).indexOf(clearance);
  return l >= 0 && c >= 0 && l <= c;
}
