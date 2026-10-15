// The fixed demo mappings for `pnpm seed:demo` (S2-008, D114, D45.5, D45.8, D67): which demo
// control satisfies which framework requirement, as plain objects, the same on every run.
// - A control is named by its demo source ID (`demo:CTL-01`, see demo-records.ts), and a
//   requirement by its framework key and its code exactly as the catalog publishes it (D212 (1)).
//   Both are found again on a re-run, and a mapping that is already there is left alone, so a
//   re-run adds nothing.
// - About 25 per org, across all four frameworks, SOC 2 included (hand mapping only, D212 (4)).
//   Each org has a control that satisfies requirements in three or more frameworks, and
//   requirements satisfied by two controls.
// - The Control Owner's own controls carry mappings, so their read-only view of them shows
//   something. The NIST and ISO choices follow NIST's own crosswalks where they can (for example
//   PR.AA-03 and IA-2 on the multi-factor sign-in control), so the links between frameworks read
//   sensibly next to the mappings.
// - Some requirements are left for the demo steps (docs/demo/s2.md): SOC 2 CC6.6 is not covered in
//   Acme, so the Compliance Manager can map a control to it and take it back.
// - The two orgs' mappings differ, so the org wall is visible.

export type DemoFrameworkKey = 'nist_800_53' | 'nist_csf_2' | 'iso_27001' | 'soc_2';

export interface DemoMapping {
  /** The control's demo source ID, `demo:<key>`. */
  control: string;
  /** The requirement's framework. */
  framework: DemoFrameworkKey;
  /** The requirement's code, as the catalog has it. */
  code: string;
}

const ACME: DemoMapping[] = [
  // CTL-01 Multi-factor sign-in for remote access (Control Owner's): four frameworks.
  { control: 'demo:CTL-01', framework: 'nist_800_53', code: 'IA-2' },
  { control: 'demo:CTL-01', framework: 'nist_csf_2', code: 'PR.AA-03' },
  { control: 'demo:CTL-01', framework: 'iso_27001', code: 'A.8.5' },
  { control: 'demo:CTL-01', framework: 'soc_2', code: 'CC6.1' },
  // CTL-02 Endpoint detection and response (Control Owner's).
  { control: 'demo:CTL-02', framework: 'nist_800_53', code: 'SI-4' },
  { control: 'demo:CTL-02', framework: 'nist_csf_2', code: 'DE.CM-01' },
  { control: 'demo:CTL-02', framework: 'iso_27001', code: 'A.8.7' },
  { control: 'demo:CTL-02', framework: 'soc_2', code: 'CC6.8' },
  // CTL-03 Monthly patching (Control Owner's).
  { control: 'demo:CTL-03', framework: 'nist_800_53', code: 'SI-2' },
  { control: 'demo:CTL-03', framework: 'iso_27001', code: 'A.8.8' },
  { control: 'demo:CTL-03', framework: 'soc_2', code: 'CC7.1' },
  // CTL-04 Security awareness training (Control Owner's).
  { control: 'demo:CTL-04', framework: 'nist_800_53', code: 'AT-2' },
  { control: 'demo:CTL-04', framework: 'nist_csf_2', code: 'PR.AT-01' },
  { control: 'demo:CTL-04', framework: 'iso_27001', code: 'A.6.3' },
  // CTL-05 Encrypted backups with an offline copy.
  { control: 'demo:CTL-05', framework: 'nist_800_53', code: 'CP-9' },
  { control: 'demo:CTL-05', framework: 'nist_csf_2', code: 'PR.DS-11' },
  { control: 'demo:CTL-05', framework: 'iso_27001', code: 'A.8.13' },
  { control: 'demo:CTL-05', framework: 'soc_2', code: 'A1.2' },
  // CTL-06 Web application firewall: DE.CM-01 has two controls (with CTL-02).
  { control: 'demo:CTL-06', framework: 'nist_800_53', code: 'SC-7' },
  { control: 'demo:CTL-06', framework: 'nist_csf_2', code: 'DE.CM-01' },
  // CTL-07 Cloud configuration monitoring: CC7.1 has two controls (with CTL-03).
  { control: 'demo:CTL-07', framework: 'nist_800_53', code: 'CM-6' },
  { control: 'demo:CTL-07', framework: 'soc_2', code: 'CC7.1' },
  // CTL-08 Quarterly privileged access reviews (restricted).
  { control: 'demo:CTL-08', framework: 'nist_800_53', code: 'AC-6' },
  { control: 'demo:CTL-08', framework: 'iso_27001', code: 'A.8.2' },
  // CTL-09 Dependency scanning and code signing.
  { control: 'demo:CTL-09', framework: 'nist_800_53', code: 'SA-11' },
  { control: 'demo:CTL-09', framework: 'nist_csf_2', code: 'PR.PS-06' },
  // CTL-10 Segregation of duties in payroll (restricted).
  { control: 'demo:CTL-10', framework: 'nist_800_53', code: 'AC-5' },
  { control: 'demo:CTL-10', framework: 'iso_27001', code: 'A.5.3' },
];

const GLOBEX: DemoMapping[] = [
  // CTL-01 Mobile device management for scanners (Control Owner's).
  { control: 'demo:CTL-01', framework: 'nist_800_53', code: 'CM-8' },
  { control: 'demo:CTL-01', framework: 'nist_csf_2', code: 'ID.AM-01' },
  { control: 'demo:CTL-01', framework: 'iso_27001', code: 'A.8.1' },
  // CTL-02 Multi-factor sign-in on the VPN (Control Owner's): four frameworks.
  { control: 'demo:CTL-02', framework: 'nist_800_53', code: 'IA-2' },
  { control: 'demo:CTL-02', framework: 'nist_800_53', code: 'AC-17' },
  { control: 'demo:CTL-02', framework: 'nist_csf_2', code: 'PR.AA-03' },
  { control: 'demo:CTL-02', framework: 'iso_27001', code: 'A.8.5' },
  { control: 'demo:CTL-02', framework: 'soc_2', code: 'CC6.1' },
  // CTL-03 Anti-malware on office PCs (Control Owner's).
  { control: 'demo:CTL-03', framework: 'nist_800_53', code: 'SI-3' },
  { control: 'demo:CTL-03', framework: 'iso_27001', code: 'A.8.7' },
  { control: 'demo:CTL-03', framework: 'soc_2', code: 'CC6.8' },
  // CTL-04 Change approval board.
  { control: 'demo:CTL-04', framework: 'nist_800_53', code: 'CM-3' },
  { control: 'demo:CTL-04', framework: 'iso_27001', code: 'A.8.32' },
  { control: 'demo:CTL-04', framework: 'soc_2', code: 'CC8.1' },
  // CTL-05 Database activity monitoring (restricted).
  { control: 'demo:CTL-05', framework: 'nist_800_53', code: 'AU-6' },
  { control: 'demo:CTL-05', framework: 'iso_27001', code: 'A.8.15' },
  // CTL-06 Warehouse failover site.
  { control: 'demo:CTL-06', framework: 'nist_800_53', code: 'CP-7' },
  { control: 'demo:CTL-06', framework: 'soc_2', code: 'A1.2' },
  // CTL-07 Partner data-sharing agreements.
  { control: 'demo:CTL-07', framework: 'nist_800_53', code: 'SA-9' },
  { control: 'demo:CTL-07', framework: 'nist_csf_2', code: 'GV.SC-05' },
  { control: 'demo:CTL-07', framework: 'iso_27001', code: 'A.5.20' },
  // CTL-08 Encryption of tracking data at rest: CC6.1 has two controls (with CTL-02).
  { control: 'demo:CTL-08', framework: 'nist_800_53', code: 'SC-28' },
  { control: 'demo:CTL-08', framework: 'nist_csf_2', code: 'PR.DS-01' },
  { control: 'demo:CTL-08', framework: 'soc_2', code: 'CC6.1' },
  // CTL-09 Daily billing reconciliation (restricted).
  { control: 'demo:CTL-09', framework: 'nist_800_53', code: 'SI-7' },
  // CTL-10 Uptime monitoring and alerting: DE.CM-01 and CC7.2.
  { control: 'demo:CTL-10', framework: 'nist_800_53', code: 'SI-4' },
  { control: 'demo:CTL-10', framework: 'nist_csf_2', code: 'DE.CM-01' },
  { control: 'demo:CTL-10', framework: 'soc_2', code: 'CC7.2' },
];

/** Each demo org's mappings, by the org's base slug (as DEMO_DATA in demo-records.ts). */
export const DEMO_MAPPINGS: Record<string, DemoMapping[]> = {
  'demo-acme': ACME,
  'demo-globex': GLOBEX,
};
