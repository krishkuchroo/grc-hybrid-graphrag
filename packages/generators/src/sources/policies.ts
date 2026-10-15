// Policy documents (D18): one text file per policy of the answer key. Each states the controls the
// policy governs (GOVERNED_BY) and the risks those controls mitigate (MITIGATED_BY), every fact in a
// sentence that names both ends.
import type { Faker } from '@faker-js/faker';
import {
  TextDoc,
  capitalise,
  factSentence,
  fileSlug,
  pickProse,
  type DocDraft,
  type OrgWorld,
  type Sentence,
} from './mess.js';

export const POLICY_SOURCE = 'policy-library';

const OWNERS = [
  'Chief Information Security Officer',
  'Head of IT Operations',
  'Chief Risk Officer',
  'Data Protection Officer',
  'Head of Governance, Risk and Compliance',
];

const PURPOSE = [
  'This policy sets out the minimum expectations {org} places on its people, systems and suppliers.',
  'It exists so that information is protected in a consistent way across every business unit.',
  'The policy supports the commitments {org} has made to customers, regulators and auditors.',
  'It translates the board-approved risk appetite into practical rules that teams can follow.',
  'Where a local procedure conflicts with this policy, the policy takes precedence.',
  'The rules below are deliberately technology neutral so that they remain valid as systems change.',
  'Everyone covered by this policy is expected to read it when they join and whenever it changes.',
];

const SCOPE = [
  'The policy applies to all employees, contractors and temporary staff of {org}.',
  'It covers every system that stores, transmits or handles company or customer information.',
  'Third parties who connect to company networks must meet the same standard through their contracts.',
  'Systems hosted by cloud providers on behalf of {org} are in scope in the same way as systems in its own data centres.',
  'Test and development environments are in scope whenever they hold copies of production data.',
  'Personal devices used for work fall under this policy for as long as they hold company data.',
];

const STATEMENT = [
  'Control owners must be able to show evidence that the control operated throughout the period.',
  'Any change to how the control operates must be approved before it takes effect.',
  'The control is tested at least once a year and the results are kept for audit.',
  'Failures of the control are reported to the security team within one working day.',
  'Where automation is available, the control should be automated rather than performed by hand.',
  'Exceptions to the control are time-bound and recorded in the exception register.',
  'The control owner reviews the design of the control whenever the systems it covers change.',
];

const GENERIC_STATEMENT = [
  'All staff must handle information according to its classification label.',
  'Access to systems is granted on the basis of business need and removed promptly when that need ends.',
  'Security incidents and near misses must be reported as soon as they are noticed.',
  'Managers are responsible for making sure their teams understand and follow this policy.',
];

const ROLES = [
  'The policy owner keeps this document current and answers questions about how to apply it.',
  'Line managers make sure that their teams complete the related training every year.',
  'The security team monitors compliance and reports the results to the risk committee each quarter.',
  'Internal audit gives independent assurance that the requirements are being met.',
  'System owners make sure that the systems they are accountable for meet every relevant requirement.',
  'Employees are expected to raise concerns through their manager or the confidential reporting line.',
];

const EXCEPTIONS = [
  'Requests for an exception are made in writing to the policy owner and must state the business reason.',
  'Each approved exception names a compensating measure and an expiry date no more than twelve months away.',
  'Exceptions that affect customer data also need the approval of the Data Protection Officer.',
  'The exception register is reviewed every quarter and expired exceptions are closed.',
];

const ENFORCEMENT = [
  'Breaches of this policy may lead to disciplinary action, up to and including dismissal.',
  'Suppliers who breach the policy may have their access suspended while the matter is investigated.',
  'Repeated or deliberate breaches are reported to the risk committee.',
];

const REVIEW = [
  'This policy is reviewed at least once a year and after any significant incident or organisational change.',
  'Minor wording changes may be approved by the policy owner; material changes need the approval of the risk committee.',
  'Superseded versions are kept in the policy library for seven years.',
];

/** One policy document per policy, in the answer key's order. */
export function draftPolicies(world: OrgWorld, faker: Faker): DocDraft[] {
  const org = world.org.name;
  return world.org.policies.map((policy) => {
    const doc = new TextDoc();
    const approver = `${faker.person.fullName()}, ${faker.helpers.arrayElement(OWNERS)}`;
    doc
      .line(org)
      .line(policy.name)
      .line(
        `Version ${policy.policyVersion} | Effective ${policy.effectiveDate} | Classification: ${capitalise(policy.label ?? 'internal')}`,
      )
      .line(`Policy owner: ${faker.helpers.arrayElement(OWNERS)}`)
      .line(`Approved by: ${approver}`)
      .line();

    doc.line('1. Purpose');
    doc.paragraph(pickProse(faker, PURPOSE, 3, 4, { org }));
    doc.line();
    doc.line('2. Scope');
    doc.paragraph(pickProse(faker, SCOPE, 2, 4, { org }));
    doc.line();

    doc.line('3. Policy statements');
    const controls = world.sources('GOVERNED_BY', policy.key);
    if (controls.length === 0) doc.paragraph(pickProse(faker, GENERIC_STATEMENT, 2, 4, { org }));
    controls.forEach((controlKey, i) => {
      const sentences: Sentence[] = [
        factSentence(faker, world, { type: 'GOVERNED_BY', fromKey: controlKey, toKey: policy.key }),
      ];
      for (const riskKey of world.sources('MITIGATED_BY', controlKey)) {
        sentences.push(factSentence(faker, world, { type: 'MITIGATED_BY', fromKey: riskKey, toKey: controlKey }));
      }
      sentences.push(...pickProse(faker, STATEMENT, 1, 3, { org }));
      doc.line();
      doc.line(`3.${i + 1} ${world.nameOf(controlKey)}`);
      doc.paragraph(sentences);
    });
    doc.line();

    doc.line('4. Roles and responsibilities');
    doc.paragraph(pickProse(faker, ROLES, 3, 4, { org }));
    doc.line();
    doc.line('5. Exceptions');
    doc.paragraph(pickProse(faker, EXCEPTIONS, 2, 3, { org }));
    doc.line();
    doc.line('6. Enforcement');
    doc.paragraph(pickProse(faker, ENFORCEMENT, 2, 3, { org }));
    doc.line();
    doc.line('7. Review');
    doc.paragraph(pickProse(faker, REVIEW, 2, 3, { org }));

    return {
      source: POLICY_SOURCE,
      kind: 'policy_document' as const,
      fileName: `${fileSlug(policy.name)}-v${policy.policyVersion}.txt`,
      format: 'txt' as const,
      paragraphs: doc.paragraphs,
      render: () => doc.render(),
    };
  });
}
