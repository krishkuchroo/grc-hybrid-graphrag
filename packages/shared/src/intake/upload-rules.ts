// Who may upload which kind (D50 "Uploads and imports"). The one place this rule lives.
import { can } from '../access/role-table.js';
import { DOCUMENT_RECORD_TYPE, isDocumentKind } from './uploads.js';

/** The Control Owner may upload evidence only; the Auditor and the Viewer upload nothing. */
export function canUpload(role: string, kind: string): boolean {
  if (!isDocumentKind(kind)) return false;
  return can(role, 'uploads', 'use', { recordType: DOCUMENT_RECORD_TYPE[kind] });
}
