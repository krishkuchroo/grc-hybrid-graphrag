// "Remove" on a mapping row (S2-007, D212 (3)), on the requirement page and the control page: the
// confirmation names the control and the requirement and says the removal is recorded in the audit
// trail (D56). The web only offers it where the API would accept it (`canMapControl`, and never on
// an AI mapping, D207); the API decides (D7), so its refusals show in plain words with their
// reference ID (D47). The refusal messages here are shared by adding and removing.
import { Ban, CopyCheck, Sparkles, SearchX, Unlink } from 'lucide-react';
import type { ReactNode } from 'react';
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
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ApiProblem } from '@/features/records/ApiProblem';

/** The two ends of a mapping, as the screen showed them when "Remove" was pressed. */
export interface MappingTarget {
  control: { id: string; number: string; name: string; label: string };
  requirement: { id: string; code: string; title: string };
  origin: string;
}

export const MAPPING_GONE_TEXT = "This record or mapping no longer exists or you can't see it.";
export const MAPPING_FORBIDDEN_TITLE = "You can't change mappings";
export const MAPPING_FORBIDDEN_TEXT =
  'Only Admins and Compliance Managers map controls to requirements, and only for controls they can see.';
export const MAPPING_EXISTS_TEXT = 'This control already satisfies this requirement.';

function ReferenceId({ id }: { id: string | undefined }) {
  return id ? (
    <p className="text-xs">
      Reference ID <span className="font-semibold select-all">{id}</span>
    </p>
  ) : null;
}

function Refused({
  icon,
  title,
  text,
  referenceId,
  tone = 'destructive',
}: {
  icon: ReactNode;
  title: string;
  text: string;
  referenceId: string | undefined;
  tone?: 'destructive' | 'default';
}) {
  return (
    <Alert variant={tone} role="alert">
      {icon}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{text}</p>
        <ReferenceId id={referenceId} />
      </AlertDescription>
    </Alert>
  );
}

/**
 * The API's refusal of a mapping change, in the screen's own words where the brief gives them:
 * a gone or hidden record or mapping (404), a role that may not map (403), a mapping already there
 * (409 `link_exists`), an AI mapping only the Analyst may remove (409 `ai_link_review_only`, in the
 * API's words), and anything else in the API's words with its reference ID.
 */
export function MappingRefusal({ error, action }: { error: unknown; action: 'add' | 'remove' }) {
  const title = action === 'add' ? 'The mapping wasn’t added' : 'The mapping wasn’t removed';
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return (
        <Refused
          icon={<SearchX aria-hidden />}
          title={title}
          text={MAPPING_GONE_TEXT}
          referenceId={error.referenceId}
        />
      );
    }
    if (error.status === 403) {
      return (
        <Refused
          icon={<Ban aria-hidden />}
          title={MAPPING_FORBIDDEN_TITLE}
          text={MAPPING_FORBIDDEN_TEXT}
          referenceId={error.referenceId}
        />
      );
    }
    if (error.code === 'link_exists') {
      return (
        <Refused
          icon={<CopyCheck aria-hidden />}
          title={title}
          text={MAPPING_EXISTS_TEXT}
          referenceId={error.referenceId}
          tone="default"
        />
      );
    }
    if (error.code === 'ai_link_review_only') {
      return (
        <Refused
          icon={<Sparkles aria-hidden />}
          title={title}
          text={error.message}
          referenceId={error.referenceId}
          tone="default"
        />
      );
    }
  }
  return <ApiProblem error={error} title={title} />;
}

export function RemoveMappingDialog({
  target,
  pending,
  onConfirm,
  onCancel,
}: {
  target: MappingTarget | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Unlink className="text-destructive size-4" aria-hidden />
            Remove this mapping?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-3">
              {target ? (
                <div className="bg-muted/40 text-foreground grid gap-1.5 rounded-md border px-3 py-2.5 text-sm">
                  <p>
                    <span className="text-muted-foreground text-xs font-medium">Control</span>{' '}
                    <span className="font-semibold tabular-nums">{target.control.number}</span> {target.control.name}
                  </p>
                  <p>
                    <span className="text-muted-foreground text-xs font-medium">Satisfies</span>{' '}
                    <span className="font-semibold">{target.requirement.code}</span> {target.requirement.title}
                  </p>
                </div>
              ) : null}
              <p>
                The control and the requirement stay as they are; only the mapping goes, and coverage is counted without
                it. The removal is recorded in the audit trail with your name.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            <Unlink aria-hidden />
            {pending ? 'Removing…' : 'Remove mapping'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
