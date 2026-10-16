// Starting AI mapping suggestions from a framework's page (S4-010; D16 (b), D20, D50, D212 (3), (4)),
// around the generated typed client (D30): POST /api/v1/mappings/suggestions, a relative address
// (the M0-015 rule). The web only offers the actions to the roles the API would accept
// (`canSuggestMappings`: Admin and Compliance Manager); the API decides (D7). Every suggestion
// waits in the Analyst's review queue, so nothing on this screen changes when a run starts.
import { useMutation } from '@tanstack/react-query';
import { canSuggestMappings, FRAMEWORKS, type FrameworkKey } from '@grc/shared';
import { api, ApiError, type PostMappingsSuggestionsBody, type PostMappingsSuggestionsResponse } from '@/api/client';
import type { Viewer } from '@/features/records/permissions';

/** One run a framework's page can start, with the words its button, confirmation and notice use. */
export interface SuggestionRun {
  /** Stable within a page: `controls:<framework>` or `soc2_to_nist`. */
  id: string;
  body: PostMappingsSuggestionsBody;
  /** The button on the page. */
  action: string;
  /** The confirmation's question. */
  question: string;
  /** What the AI does, in one sentence. */
  explanation: string;
  /** Why it can take a long time. */
  pace: string;
  /** What waits for the Analyst, and what doesn't change until then. */
  reviewNote: string;
  /** The run as the subject of the notice: "Mapping suggestions for ISO/IEC 27001". */
  subject: string;
}

/** Whether the person may start mapping suggestions at all (the Framework-mappings `edit` cell). */
export function mayStartSuggestions(viewer: Viewer | null): boolean {
  return viewer !== null && canSuggestMappings(viewer.role);
}

/**
 * The runs a framework's page offers: suggestions from the person's controls to this framework's
 * requirements on every framework, and on the SOC 2 page also links from each SOC 2 criterion to
 * NIST SP 800-53 controls (D20, D212 (4)).
 */
export function suggestionRunsFor(key: FrameworkKey): SuggestionRun[] {
  const name = FRAMEWORKS[key].name;
  const runs: SuggestionRun[] = [
    {
      id: `controls:${key}`,
      body: { kind: 'controls', framework: key },
      action: 'Suggest mappings',
      question: `Suggest mappings to ${name}?`,
      explanation: `The AI reads each active control you can see and suggests which ${name} requirements it satisfies.`,
      pace: 'It can take a long time: the AI reads your controls one at a time.',
      reviewNote:
        'Every suggestion goes to the Analyst’s review queue. Nothing is mapped, and coverage doesn’t change, until an Analyst approves it.',
      subject: `Mapping suggestions for ${name}`,
    },
  ];
  if (key === 'soc_2') {
    const nist = FRAMEWORKS.nist_800_53.name;
    runs.push({
      id: 'soc2_to_nist',
      body: { kind: 'soc2_to_nist' },
      action: 'Suggest links to NIST 800-53',
      question: 'Suggest links to NIST 800-53?',
      explanation: `The AI reads each SOC 2 criterion and suggests which ${nist} controls it maps to.`,
      pace: 'It can take a long time: the AI reads the criteria one at a time.',
      reviewNote:
        'Every suggestion goes to the Analyst’s review queue. No link between the two frameworks is added until an Analyst approves it.',
      subject: `Link suggestions from SOC 2 to ${nist}`,
    });
  }
  return runs;
}

/** What the page shows once a run was asked for and the API accepted the request. */
export interface SuggestionOutcome {
  run: SuggestionRun;
  answer: PostMappingsSuggestionsResponse;
}

/** Asks the API to start one run. Never retried on its own: a repeat is the person's choice. */
export function useStartSuggestions() {
  return useMutation({
    mutationFn: (body: PostMappingsSuggestionsBody) => api.postMappingsSuggestions(body),
    retry: false,
  });
}

/** A refusal in the screen's own words where it has them (403, 429), else `null`: the API's words. */
export function suggestionRefusal(error: unknown): { title: string; text: string } | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 403) {
    return {
      title: 'You can’t start mapping suggestions',
      text: 'Only Admins and Compliance Managers start AI mapping suggestions.',
    };
  }
  if (error.status === 429) {
    return {
      title: 'Too many requests',
      text: error.retryAfterSeconds
        ? `Try again in ${error.retryAfterSeconds} second${error.retryAfterSeconds === 1 ? '' : 's'}.`
        : 'Wait a minute, then try again.',
    };
  }
  return null;
}
