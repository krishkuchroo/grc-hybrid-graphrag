// A refused or failed request, in the API's own words with its reference ID (D47), so support can
// find the log line.
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export function ApiProblem({ error, title, children }: { error: unknown; title: string; children?: ReactNode }) {
  const message = error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
  const referenceId = error instanceof ApiError ? error.referenceId : undefined;
  return (
    <Alert variant="destructive" role="alert">
      <TriangleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {referenceId ? (
          <p className="text-xs">
            Reference ID <span className="font-semibold select-all">{referenceId}</span>
          </p>
        ) : null}
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** The one answer for a record that is missing or hidden, whatever the cause (no leak of which). */
export const NOT_FOUND_TEXT = "This record doesn't exist or you can't see it.";
