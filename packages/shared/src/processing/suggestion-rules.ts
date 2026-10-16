// Who may start AI mapping suggestions (D50 "Framework mappings" row, D212 (3), (4)): exactly the
// roles whose Framework-mappings cell is `edit` (Admin and Compliance Manager), for people and API
// keys alike. The Analyst's `approve` cell is for deciding the suggestions (S5), not starting them.
// Anything unknown is refused (fail safe, D45.7).
import { can } from '../access/role-table.js';

export function canSuggestMappings(role: string): boolean {
  return can(role, 'framework_mapping', 'edit');
}
