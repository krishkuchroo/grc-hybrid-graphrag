// The screens of the workspace (D27), in the order the left navigation shows them. Home has its own
// page; the others open as their slices are built (S1–S8) and show an empty state until then.
import {
  ClipboardList,
  FileText,
  FlaskConical,
  Gauge,
  History,
  Inbox,
  Library,
  type LucideIcon,
  Server,
  ShieldAlert,
  ShieldCheck,
  Siren,
  UserCog,
} from 'lucide-react';

export interface Screen {
  path: string;
  label: string;
  icon: LucideIcon;
  /** What the screen is for, in a line. */
  summary: string;
  /** What the empty screen says until records exist. */
  empty: string;
}

export interface ScreenGroup {
  label: string;
  screens: Screen[];
}

export const HOME: Screen = {
  path: '/',
  label: 'Home',
  icon: Gauge,
  summary: 'Your workspace at a glance.',
  empty: '',
};

export const SCREEN_GROUPS: ScreenGroup[] = [
  {
    label: 'Risk',
    screens: [
      {
        path: '/risks',
        label: 'Risk register',
        icon: ShieldAlert,
        summary: 'Every risk in your organisation, with its owner, rating and the controls that treat it.',
        empty: 'No risks are recorded yet. Risks appear here once they are added or imported.',
      },
      {
        path: '/controls',
        label: 'Controls',
        icon: ShieldCheck,
        summary: 'The safeguards you run, what they mitigate and which requirements they satisfy.',
        empty: 'No controls are recorded yet.',
      },
      {
        path: '/policies',
        label: 'Policies',
        icon: FileText,
        summary: 'Your policies and the controls they govern.',
        empty: 'No policies are recorded yet.',
      },
      {
        path: '/assets',
        label: 'Assets',
        icon: Server,
        summary: 'Systems, applications and data stores, with a map of what depends on what.',
        empty: 'No assets are recorded yet. Import an asset list from Data intake to fill this screen.',
      },
      {
        path: '/incidents',
        label: 'Incidents',
        icon: Siren,
        summary: 'Security incidents and the assets and risks they touched.',
        empty: 'No incidents are recorded yet.',
      },
    ],
  },
  {
    label: 'Compliance',
    screens: [
      {
        path: '/frameworks',
        label: 'Frameworks',
        icon: Library,
        summary: 'NIST 800-53, CSF 2.0, ISO 27001 and SOC 2, and how your controls map to them.',
        empty: 'Framework catalogs appear here once they are loaded for your organisation.',
      },
      {
        path: '/review',
        label: 'Analyst review',
        icon: ClipboardList,
        summary: 'Links the extraction was unsure about, waiting for an Analyst to approve or reject.',
        empty: 'Nothing is waiting for review.',
      },
    ],
  },
  {
    label: 'Data',
    screens: [
      {
        path: '/intake',
        label: 'Data intake',
        icon: Inbox,
        summary: 'Uploads, their processing status and the sample-data generators.',
        empty: 'No files have been uploaded yet.',
      },
    ],
  },
  {
    label: 'Administration',
    screens: [
      {
        path: '/admin',
        label: 'Admin',
        icon: UserCog,
        summary: 'People, roles, clearances, cross-org grants and the break-glass log.',
        empty: 'User and access management opens here.',
      },
      {
        path: '/audit',
        label: 'Audit trail',
        icon: History,
        summary: 'Every change, sign-in and decision, in a tamper-evident record.',
        empty: 'Audit entries for your organisation appear here.',
      },
      {
        path: '/benchmark',
        label: 'Benchmark',
        icon: FlaskConical,
        summary: 'Hybrid search against vector-only search, run by run.',
        empty: 'No benchmark runs yet.',
      },
    ],
  },
];

export const SCREENS: Screen[] = SCREEN_GROUPS.flatMap((g) => g.screens);
