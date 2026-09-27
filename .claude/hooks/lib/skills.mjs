// The approved skills, read from skills.md, the single source of truth
// (D80, D87). Plugin skills are named plugin:skill, the way the Skill tool
// names them. Built-in skills in the "Allowed exception" section have no
// plugin prefix.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from './paths.mjs';

export function approvedSkills(markdown) {
  const names = new Set();
  let section = '';
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      section = heading[1].toLowerCase();
      continue;
    }
    if (section.startsWith('approved skills') && line.startsWith('|')) {
      const cells = line.split('|').map((c) => c.trim());
      const skill = /`([^`]+)`/.exec(cells[2] ?? '')?.[1];
      const plugin = /^([A-Za-z0-9._-]+)/.exec(cells[3] ?? '')?.[1];
      if (skill && plugin) names.add(`${plugin}:${skill}`);
    } else if (section.startsWith('allowed exception')) {
      for (const m of line.matchAll(/`([^`]+)`/g)) names.add(m[1]);
    }
  }
  return names;
}

export function loadApprovedSkills(file = join(PROJECT_DIR, 'skills.md')) {
  return approvedSkills(readFileSync(file, 'utf8'));
}
