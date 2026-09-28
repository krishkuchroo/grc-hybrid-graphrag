// TEST-005 (D186, D175, D51, D56, D59): the label rule of every security-matrix row that isn't a
// record, pinned by name, so a later change can't flip one unnoticed.
//
// - uploads and review_queue: documents carry a label and their findings inherit it (D51, D66).
// - chat: it sees only what the user may see (D51, D52).
// - audit_trail: an entry about a record above the reader's clearance shows who, when, the record
//   number and the action, but not its before/after contents (D186, D56).
// - admin: org settings and users carry no sensitivity label (D50, D51).
//
// It imports the matrix only: no database, server or .env.
import { SECURITY_MATRIX } from '@grc/shared';
import { describe, expect, it } from 'vitest';

const EXPECTED_LABELS: Record<string, boolean> = {
  uploads: true,
  review_queue: true,
  chat: true,
  audit_trail: true,
  admin: false,
};

describe('security matrix: label rule of the non-record rows (D186, D175, D51)', () => {
  for (const [subject, expected] of Object.entries(EXPECTED_LABELS)) {
    it(`${subject} has labels: ${String(expected)}`, () => {
      const rows = SECURITY_MATRIX.recordTypes.filter((t) => t.subject === subject);
      expect(rows.length, `security matrix row "${subject}" is missing or listed more than once`).toBe(1);
      expect(rows[0]?.labels, `security matrix row "${subject}": labels`).toBe(expected);
    });
  }
});
