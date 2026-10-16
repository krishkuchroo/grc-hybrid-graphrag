// Internal audit reports (D41: logs arrive as audit findings): reports drafted as text (render-sources
// writes a seeded half as PDF, S8-007) whose findings each concern one risk of the answer key, name
// the assets exposed to it (EXPOSED_TO) and the controls meant to mitigate it (MITIGATED_BY), every
// fact in a sentence that names both ends.
import type { Faker } from '@faker-js/faker';
import { riskRating } from '@grc/shared';
import {
  DAY_MS,
  REFERENCE_MS,
  TextDoc,
  capitalise,
  factSentence,
  fileSlug,
  isoDay,
  pickProse,
  type DocDraft,
  type OrgWorld,
  type Sentence,
} from './mess.js';

export const AUDIT_SOURCE = 'internal-audit';

/** At most this many findings (one per risk) in one report. */
export const FINDINGS_PER_REPORT = 10;

const TITLES = [
  'IT General Controls Review',
  'Information Security Risk Audit',
  'Access Management Audit',
  'Operational Resilience Review',
  'Third-Party Risk Audit',
  'Data Protection Audit',
  'Infrastructure Security Review',
  'Cyber Risk Management Audit',
];

const SUMMARY = [
  'Internal audit carried out this review as part of the annual plan approved by the audit committee.',
  'Overall, the control environment was found to be partly effective, with several areas needing attention.',
  'Management engaged constructively throughout the fieldwork and has agreed actions for every finding.',
  'The findings below are ranked by the rating of the risk they concern.',
  'Progress on the agreed actions will be followed up in the next audit cycle.',
  'No finding was judged to require immediate escalation to the board.',
];

const APPROACH = [
  'The audit team interviewed control owners and walked through each control with them.',
  'Samples were selected from the full period and tested against the documented control design.',
  'Configuration settings were inspected directly on the systems in scope where access allowed.',
  'The work followed the internal audit methodology and the relevant professional standards.',
  'Evidence was retained in the audit file and is available to the external auditors on request.',
];

const CONDITIONS = [
  'Testing identified weaknesses in how this risk is managed.',
  'The walkthrough showed that the documented design is not always followed in practice.',
  'Sample testing found exceptions that were not picked up by the control owners.',
  'Evidence of operation could not be produced for part of the period.',
  'Monitoring of this area relies on manual checks that were not performed consistently.',
];

const CAUSES = [
  'The root cause appears to be unclear ownership after a recent reorganisation.',
  'Staff turnover in the team left the procedure without a trained operator for several weeks.',
  'The tooling in use does not produce the reports that the procedure assumes.',
  'Competing priorities meant that the periodic review was postponed twice.',
];

const RECOMMENDATIONS = [
  'Management should confirm a single accountable owner and document the procedure.',
  'The control should be automated where possible and its operation evidenced each period.',
  'A periodic review should be scheduled and tracked in the governance calendar.',
  'Exceptions found during testing should be investigated and remediated.',
];

const RESPONSES = [
  'Management accepts the finding and will complete the action by the target date.',
  'Agreed; the owner has started work on the remediation plan.',
  'Management accepts the finding and has already begun to address the root cause.',
  'Agreed, subject to budget approval in the next planning round.',
];

const CONCLUSION = [
  'The agreed actions, once complete, should bring the residual risk back within appetite.',
  'Internal audit thanks the teams involved for their time and openness during the review.',
  'A follow-up review will confirm that the actions have been completed and are effective.',
];

/** Reports of at most `FINDINGS_PER_REPORT` findings, one finding per risk, covering every risk once. */
export function draftAuditReports(world: OrgWorld, faker: Faker): DocDraft[] {
  const org = world.org.name;
  const risks = faker.helpers.shuffle([...world.org.risks]);
  const drafts: DocDraft[] = [];
  const titles = faker.helpers.shuffle([...TITLES]);
  for (let start = 0, n = 1; start < risks.length; start += FINDINGS_PER_REPORT, n++) {
    const chunk = risks.slice(start, start + FINDINGS_PER_REPORT);
    const title = titles[(n - 1) % titles.length]!;
    const reference = `IA-2026-${String(n).padStart(2, '0')}`;
    const end = REFERENCE_MS - (n - 1) * 30 * DAY_MS;
    const doc = new TextDoc()
      .line(`${org} Internal Audit`)
      .title(title)
      .line(`Report reference: ${reference}`)
      .line(`Audit period: ${isoDay(end - 365 * DAY_MS)} to ${isoDay(end)}`)
      .line(`Lead auditor: ${faker.person.fullName()}`)
      .line('Distribution: Audit Committee; Chief Information Security Officer; Chief Risk Officer')
      .line();
    doc.line('1. Executive summary');
    doc.paragraph(pickProse(faker, SUMMARY, 3, 4, { org }));
    doc.line().line('2. Scope and approach');
    doc.paragraph(pickProse(faker, APPROACH, 2, 4, { org }));
    doc.line().line('3. Findings');

    chunk.forEach((risk, i) => {
      const exposed = world.sources('EXPOSED_TO', risk.key);
      const controls = world.targets('MITIGATED_BY', risk.key);
      const sentences: Sentence[] = [
        ...pickProse(faker, CONDITIONS, 1, 1, { org }),
        ...exposed.map((assetKey) =>
          factSentence(faker, world, { type: 'EXPOSED_TO', fromKey: assetKey, toKey: risk.key }),
        ),
        ...controls.map((controlKey) =>
          factSentence(faker, world, { type: 'MITIGATED_BY', fromKey: risk.key, toKey: controlKey }),
        ),
        ...pickProse(faker, CAUSES, 1, 1, { org }),
      ];
      const target = isoDay(end + faker.number.int({ min: 30, max: 180 }) * DAY_MS);
      doc.line();
      doc.line(`Finding ${i + 1}: ${risk.name}`);
      doc.line(`Rating: ${capitalise(riskRating(risk.impact, risk.likelihood).band)}`);
      doc.paragraph(sentences);
      doc.paragraph(pickProse(faker, RECOMMENDATIONS, 1, 2, { org }), 'Recommendation: ');
      doc.paragraph(pickProse(faker, RESPONSES, 1, 1, { org }), 'Management response: ');
      doc.line(`Target date: ${target}`);
    });

    doc.line().line('4. Conclusion');
    doc.paragraph(pickProse(faker, CONCLUSION, 2, 3, { org }));
    drafts.push({
      source: AUDIT_SOURCE,
      kind: 'audit_report',
      fileName: `${reference.toLowerCase()}-${fileSlug(title)}.txt`,
      format: 'txt',
      paragraphs: doc.paragraphs,
      render: () => doc.render(),
      layout: () => doc.layout(),
    });
  }
  return drafts;
}
