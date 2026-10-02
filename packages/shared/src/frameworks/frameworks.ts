// The four framework catalogs (D20): their keys, names, versions and groups, and the mapping link
// types (D67). Keys are stored lowercase with `_`, like S1's values.

export const FRAMEWORK_KEYS = ['nist_800_53', 'nist_csf_2', 'iso_27001', 'soc_2'] as const;

export type FrameworkKey = (typeof FRAMEWORK_KEYS)[number];

export function isFrameworkKey(v: unknown): v is FrameworkKey {
  return typeof v === 'string' && (FRAMEWORK_KEYS as readonly string[]).includes(v);
}

export interface FrameworkInfo {
  /** The name shown, for example `NIST SP 800-53`. */
  name: string;
  /** The framework's own edition (not the record's `version` counter). */
  frameworkVersion: string;
  publisher: string;
  /** Our own one-line description. */
  description: string;
  /** Group code to group name, in the order the framework publishes its groups. */
  groupNames: Readonly<Record<string, string>>;
}

function info(value: FrameworkInfo): Readonly<FrameworkInfo> {
  return Object.freeze({ ...value, groupNames: Object.freeze({ ...value.groupNames }) });
}

export const FRAMEWORKS: Readonly<Record<FrameworkKey, Readonly<FrameworkInfo>>> = Object.freeze({
  nist_800_53: info({
    name: 'NIST SP 800-53',
    frameworkVersion: 'Rev. 5',
    publisher: 'NIST',
    description: 'Security and privacy controls for information systems and organizations.',
    groupNames: {
      AC: 'Access Control',
      AT: 'Awareness and Training',
      AU: 'Audit and Accountability',
      CA: 'Assessment, Authorization, and Monitoring',
      CM: 'Configuration Management',
      CP: 'Contingency Planning',
      IA: 'Identification and Authentication',
      IR: 'Incident Response',
      MA: 'Maintenance',
      MP: 'Media Protection',
      PE: 'Physical and Environmental Protection',
      PL: 'Planning',
      PM: 'Program Management',
      PS: 'Personnel Security',
      PT: 'PII Processing and Transparency',
      RA: 'Risk Assessment',
      SA: 'System and Services Acquisition',
      SC: 'System and Communications Protection',
      SI: 'System and Information Integrity',
      SR: 'Supply Chain Risk Management',
    },
  }),
  nist_csf_2: info({
    name: 'NIST Cybersecurity Framework',
    frameworkVersion: '2.0',
    publisher: 'NIST',
    description:
      'Cybersecurity outcomes that help an organization understand, assess, prioritize and manage its risks.',
    groupNames: {
      'GV.OC': 'Organizational Context',
      'GV.RM': 'Risk Management Strategy',
      'GV.RR': 'Roles, Responsibilities, and Authorities',
      'GV.PO': 'Policy',
      'GV.OV': 'Oversight',
      'GV.SC': 'Cybersecurity Supply Chain Risk Management',
      'ID.AM': 'Asset Management',
      'ID.RA': 'Risk Assessment',
      'ID.IM': 'Improvement',
      'PR.AA': 'Identity Management, Authentication, and Access Control',
      'PR.AT': 'Awareness and Training',
      'PR.DS': 'Data Security',
      'PR.PS': 'Platform Security',
      'PR.IR': 'Technology Infrastructure Resilience',
      'DE.CM': 'Continuous Monitoring',
      'DE.AE': 'Adverse Event Analysis',
      'RS.MA': 'Incident Management',
      'RS.AN': 'Incident Analysis',
      'RS.CO': 'Incident Response Reporting and Communication',
      'RS.MI': 'Incident Mitigation',
      'RC.RP': 'Incident Recovery Plan Execution',
      'RC.CO': 'Incident Recovery Communication',
    },
  }),
  iso_27001: info({
    name: 'ISO/IEC 27001',
    frameworkVersion: '2022',
    publisher: 'ISO/IEC',
    description: 'Requirements for an information security management system, with the Annex A reference controls.',
    groupNames: {
      'A.5': 'Organizational controls',
      'A.6': 'People controls',
      'A.7': 'Physical controls',
      'A.8': 'Technological controls',
    },
  }),
  soc_2: info({
    name: 'SOC 2 Trust Services Criteria',
    frameworkVersion: '2017 (revised points of focus 2022)',
    publisher: 'AICPA',
    description:
      'Criteria for reporting on controls over security, availability, processing integrity, confidentiality and privacy.',
    groupNames: {
      CC1: 'Control Environment',
      CC2: 'Communication and Information',
      CC3: 'Risk Assessment',
      CC4: 'Monitoring Activities',
      CC5: 'Control Activities',
      CC6: 'Logical and Physical Access Controls',
      CC7: 'System Operations',
      CC8: 'Change Management',
      CC9: 'Risk Mitigation',
      A1: 'Additional Criteria for Availability',
      C1: 'Additional Criteria for Confidentiality',
      PI1: 'Additional Criteria for Processing Integrity',
      P1: 'Privacy Criteria Related to Notice and Communication of Objectives Related to Privacy',
      P2: 'Privacy Criteria Related to Choice and Consent',
      P3: 'Privacy Criteria Related to Collection',
      P4: 'Privacy Criteria Related to Use, Retention, and Disposal',
      P5: 'Privacy Criteria Related to Access',
      P6: 'Privacy Criteria Related to Disclosure and Notification',
      P7: 'Privacy Criteria Related to Quality',
      P8: 'Privacy Criteria Related to Monitoring and Enforcement',
    },
  }),
});

/** The two mapping links (D67): people (and later the AI) say a control satisfies a requirement;
 * NIST's own mappings say a requirement maps to another framework's requirement. */
export const MAPPING_LINK_TYPES = [
  { type: 'SATISFIES', from: 'control', to: 'requirement' },
  { type: 'MAPS_TO', from: 'requirement', to: 'requirement' },
] as const;

export type MappingLinkType = (typeof MAPPING_LINK_TYPES)[number]['type'];
