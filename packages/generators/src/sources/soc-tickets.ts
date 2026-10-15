// SOC tickets (D41: logs arrive as SOC tickets): one ticket per incident of the answer key, from a
// SIEM that exports flat JSON or a service desk that exports text. Each states the assets the
// incident impacted (IMPACTS) and the risks it exposed (EXPOSES), every fact in a sentence that names
// both ends. The ticket never names the incident in its prose, so no sentence links it by accident.
import type { Faker } from '@faker-js/faker';
import type { IncidentStatus } from '@grc/shared';
import type { WorldRecord } from '../world/index.js';
import {
  JsonDoc,
  TextDoc,
  capitalise,
  factSentence,
  pickProse,
  titleCase,
  type DocDraft,
  type OrgWorld,
  type Sentence,
} from './mess.js';

/** The two ticket sources: a SIEM's case export (JSON) and the SOC service desk (text). */
export const SOC_SOURCES = { json: 'soc-siem', txt: 'soc-service-desk' } as const;

const CATEGORIES: readonly [RegExp, string][] = [
  [/malware/i, 'malware'],
  [/login|brute/i, 'account_compromise'],
  [/phishing/i, 'phishing'],
  [/outage/i, 'availability'],
  [/leak/i, 'data_loss'],
  [/change/i, 'unauthorised_change'],
  [/certificate/i, 'configuration'],
  [/scan/i, 'reconnaissance'],
  [/laptop/i, 'lost_device'],
];

const OPENERS = [
  'An alert was raised by the monitoring platform and picked up by the on-call analyst.',
  'The first report came from a member of staff who noticed unusual behaviour.',
  'Automated detection flagged the activity outside normal working hours.',
  'The service desk escalated the case to security operations after a user complaint.',
  'A correlation rule in the SIEM matched several related events within a short window.',
];

const CLOSERS = [
  'The ticket will be updated as the investigation progresses.',
  'Business owners were asked to report any further unusual behaviour.',
  'The severity will be reviewed once containment is confirmed.',
  'A follow-up review is planned with the affected teams.',
];

const NOTES = [
  'Logs from the affected systems were preserved for the investigation.',
  'The analyst confirmed the alert was not a duplicate of an open case.',
  'Indicators of compromise were shared with the threat intelligence team.',
  'No evidence was found that customer data left the network.',
  'The owners of the affected systems were informed and joined the bridge call.',
  'Firewall and proxy logs were reviewed for related activity in the previous thirty days.',
  'Endpoint detection telemetry was pulled for every host involved.',
  'The case was linked to the weekly security operations report.',
];

const TIMELINE = [
  'Alert received and acknowledged by the on-call analyst.',
  'Initial triage completed and severity confirmed.',
  'Affected systems isolated from the wider network.',
  'Containment actions verified by a second analyst.',
  'Stakeholders briefed on the current position.',
  'Monitoring increased for related indicators.',
];

const RESOLUTIONS: Readonly<Record<IncidentStatus, readonly string[]>> = {
  new: ['The case is waiting for initial triage.', 'No containment action has been taken yet.'],
  investigating: [
    'The investigation is ongoing and the root cause is not yet known.',
    'Further log analysis is planned before any systems are restored.',
  ],
  contained: [
    'The threat has been contained and the affected systems are under close watch.',
    'Eradication steps are scheduled for the next maintenance window.',
  ],
  resolved: [
    'The root cause was removed and the affected systems were restored to normal service.',
    'A short lessons-learned review has been booked with the system owners.',
  ],
  closed: [
    'All actions are complete and the case has been closed.',
    'The lessons learned were recorded and the related procedures were updated.',
  ],
};

function categoryOf(name: string): string {
  return CATEGORIES.find(([pattern]) => pattern.test(name))?.[1] ?? 'other';
}

function minutesAfter(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString().slice(0, 16).replace('T', ' ');
}

function facts(faker: Faker, world: OrgWorld, incident: WorldRecord<'incident'>): Sentence[] {
  return [
    ...world
      .targets('IMPACTS', incident.key)
      .map((assetKey) => factSentence(faker, world, { type: 'IMPACTS', fromKey: incident.key, toKey: assetKey })),
    ...world
      .targets('EXPOSES', incident.key)
      .map((riskKey) => factSentence(faker, world, { type: 'EXPOSES', fromKey: incident.key, toKey: riskKey })),
  ];
}

/** One ticket per incident, in the answer key's order; the two sources take turns from a seeded start. */
export function draftSocTickets(world: OrgWorld, faker: Faker): DocDraft[] {
  const offset = faker.number.int({ min: 0, max: 1 });
  const counters = {
    json: faker.number.int({ min: 10_000, max: 59_999 }),
    txt: faker.number.int({ min: 100_000, max: 599_999 }),
  };
  return world.org.incidents.map((incident, i): DocDraft => {
    const format = (i + offset) % 2 === 0 ? 'json' : 'txt';
    const reporter = faker.person.fullName();
    const assignee = faker.person.fullName();
    const description = [
      ...pickProse(faker, OPENERS, 1, 1),
      ...facts(faker, world, incident),
      ...pickProse(faker, CLOSERS, 1, 1),
    ];
    const notes = pickProse(faker, NOTES, 2, 3);
    const resolution = pickProse(faker, RESOLUTIONS[incident.incidentStatus], 1, 2);

    if (format === 'json') {
      const ticketId = `SIEM-${counters.json++}`;
      const doc = new JsonDoc()
        .field('ticketId', ticketId)
        .field('source', 'SIEM case export')
        .field('title', incident.name)
        .field('severity', incident.severity)
        .field('status', incident.incidentStatus)
        .field('category', categoryOf(incident.name))
        .field('createdAt', incident.occurredAt)
        .field('reporter', reporter)
        .field('assignee', assignee);
      doc.paragraph('description', description);
      doc.paragraph('analystNotes', notes);
      doc.paragraph('resolution', resolution);
      return {
        source: SOC_SOURCES.json,
        kind: 'soc_ticket',
        fileName: `${ticketId}.json`,
        format: 'json',
        paragraphs: doc.paragraphs,
        render: () => doc.render(),
      };
    }

    const ticketId = `SEC-${counters.txt++}`;
    const doc = new TextDoc()
      .line(`Ticket: ${ticketId}`)
      .line('Queue: Security Operations')
      .line(`Title: ${incident.name}`)
      .line(`Severity: ${capitalise(incident.severity)}`)
      .line(`Status: ${titleCase(incident.incidentStatus)}`)
      .line(`Opened: ${incident.occurredAt}`)
      .line(`Reporter: ${reporter}`)
      .line(`Assignee: ${assignee}`)
      .line()
      .line('Description');
    doc.paragraph(description);
    doc.line().line('Timeline');
    let minutes = 0;
    for (const step of pickProse(faker, TIMELINE, 2, 4)) {
      minutes += faker.number.int({ min: 5, max: 240 });
      doc.paragraph([step], `- ${minutesAfter(incident.occurredAt, minutes)} UTC  `);
    }
    doc.line().line('Analyst notes');
    doc.paragraph(notes);
    doc.line().line('Resolution');
    doc.paragraph(resolution);
    return {
      source: SOC_SOURCES.txt,
      kind: 'soc_ticket',
      fileName: `${ticketId}.txt`,
      format: 'txt',
      paragraphs: doc.paragraphs,
      render: () => doc.render(),
    };
  });
}
