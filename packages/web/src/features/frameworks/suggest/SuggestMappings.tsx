// "Suggest mappings" on every framework's page, and "Suggest links to NIST 800-53" on the SOC 2 page
// (S4-010; D16 (b), D20, D212 (3), (4)), for Admins and Compliance Managers only. Each action asks
// first, in plain words: the run works in the background on the local AI, it can take a long time,
// and every suggestion waits in the Analyst's review queue before anything changes. Confirming
// sends POST /api/v1/mappings/suggestions; the page then shows "Started" or "Already running". A
// refusal stays in the confirmation with the API's reference ID (D47), as Retire does.
import type { FrameworkKey } from '@grc/shared';
import { Ban, CircleCheck, Cpu, Hourglass, Inbox, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ApiProblem } from '@/features/records/ApiProblem';
import { useViewer } from '../mapping/useMappings';
import {
  mayStartSuggestions,
  suggestionRefusal,
  suggestionRunsFor,
  useStartSuggestions,
  type SuggestionOutcome,
  type SuggestionRun,
} from './useSuggestions';

function ReferenceId({ id }: { id: string | undefined }) {
  return id ? (
    <p className="text-xs">
      Reference ID <span className="font-semibold select-all">{id}</span>
    </p>
  ) : null;
}

/** The API's refusal: 403 and 429 in plain words, anything else in the API's words. */
function SuggestionRefused({ error }: { error: unknown }) {
  const plain = suggestionRefusal(error);
  if (plain === null) return <ApiProblem error={error} title="The suggestions didn’t start" />;
  return (
    <Alert variant="destructive" role="alert">
      {error instanceof ApiError && error.status === 403 ? <Ban aria-hidden /> : <TriangleAlert aria-hidden />}
      <AlertTitle>{plain.title}</AlertTitle>
      <AlertDescription>
        <p>{plain.text}</p>
        <ReferenceId id={error instanceof ApiError ? error.referenceId : undefined} />
      </AlertDescription>
    </Alert>
  );
}

function Point({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1rem_1fr] items-start gap-2.5">
      <span className="text-primary mt-0.5 [&>svg]:size-4">{icon}</span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}

function SuggestDialog({ run, onOutcome }: { run: SuggestionRun; onOutcome: (outcome: SuggestionOutcome) => void }) {
  const [open, setOpen] = useState(false);
  const start = useStartSuggestions();

  const confirm = () => {
    if (start.isPending) return;
    start.mutate(run.body, {
      onSuccess: (answer) => {
        setOpen(false);
        onOutcome({ run, answer });
      },
    });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && start.isPending) return;
        if (next) start.reset();
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Sparkles className="text-primary" aria-hidden />
          {run.action}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Sparkles className="text-primary size-4" aria-hidden />
            {run.question}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-3">
              <p>{run.explanation}</p>
              <ul className="bg-muted/40 text-foreground grid gap-2.5 rounded-md border px-3.5 py-3">
                <Point icon={<Cpu aria-hidden />}>
                  It runs in the background on the local AI. You can leave this page while it works.
                </Point>
                <Point icon={<Hourglass aria-hidden />}>{run.pace}</Point>
                <Point icon={<Inbox aria-hidden />}>{run.reviewNote}</Point>
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {start.error ? <SuggestionRefused error={start.error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={start.isPending}>Cancel</AlertDialogCancel>
          <Button type="button" disabled={start.isPending} onClick={confirm}>
            <Sparkles aria-hidden />
            {start.isPending ? 'Starting…' : 'Start suggestions'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The page's AI suggestion actions, or nothing for anyone who may not start them (everyone but
 * Admins and Compliance Managers, and anyone until the shell knows who they are).
 */
export function SuggestMappingsActions({
  frameworkKey,
  onOutcome,
}: {
  frameworkKey: FrameworkKey;
  onOutcome: (outcome: SuggestionOutcome) => void;
}) {
  const viewer = useViewer();
  if (!mayStartSuggestions(viewer)) return null;
  return (
    <div role="group" aria-label="AI suggestions" className="flex flex-wrap items-center gap-2">
      {suggestionRunsFor(frameworkKey).map((run) => (
        <SuggestDialog key={run.id} run={run} onOutcome={onOutcome} />
      ))}
    </div>
  );
}

/** "Started" or "Already running", with where the suggestions go. */
export function SuggestionNotice({ outcome, onDismiss }: { outcome: SuggestionOutcome; onDismiss: () => void }) {
  const { run, answer } = outcome;
  const started = answer.status === 'started';
  return (
    <Alert variant="info" role="status" className="pr-12">
      {started ? <CircleCheck aria-hidden /> : <Hourglass aria-hidden />}
      <AlertTitle>{started ? 'Started' : 'Already running'}</AlertTitle>
      <AlertDescription>
        <p>
          {started
            ? `${run.subject} have started in the background on the local AI.`
            : `${run.subject} are already running in your organisation, so no second run was started.`}{' '}
          Each suggestion goes to the Analyst’s review queue for approval before anything changes.
        </p>
        {answer.status === 'started' ? (
          <p className="text-xs">
            Job ID <span className="font-semibold select-all">{answer.jobId}</span>
          </p>
        ) : null}
      </AlertDescription>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-1.5 right-1.5 size-8 text-current hover:bg-black/5"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X aria-hidden />
      </Button>
    </Alert>
  );
}
