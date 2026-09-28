// The allowed field values (D197). Stored lowercase, with `_` between words.
export const RISK_SCALE = [1, 2, 3, 4, 5] as const;
export type RiskScaleValue = (typeof RISK_SCALE)[number];

export const ASSET_TYPES = [
  'server',
  'application',
  'database',
  'network_device',
  'cloud_service',
  'endpoint',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const CONTROL_STATUSES = ['not_implemented', 'planned', 'implemented'] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];

export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ['new', 'investigating', 'contained', 'resolved', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
