// Data intake (S3-011, D27 screen 10), after ServiceNow's import screens (D2): the upload panel
// and the uploaded documents, with their status, filters and downloads. Who may upload which kind
// comes from `canUpload` (D50); the documents list is the API's answer, so a role without the
// uploads cell (the Control Owner, Auditor and Viewer) gets its 403 and the no-access screen here
// (D7). A Control Owner is told where evidence goes instead: a control's own page. Admins also get
// the "Sample data" part (S3-015, D213 (6)): what API keys sent and how to run the generators.
import { Link } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import type { PostUploadsResponse } from '@/api/client';
import { PageHeader } from '@/app/ScreenPage';
import { SCREENS } from '@/app/screens';
import { formatRole } from '@/features/auth/session';
import { useMe } from '@/features/records/useRecords';
import { DocumentsTable } from './DocumentsTable';
import { listedKinds, uploadKinds } from './permissions';
import { SampleDataPanel } from './SampleDataPanel';
import { UploadPanel } from './UploadPanel';
import { isForbidden, useDocumentRows, type IntakeSearch } from './useDocuments';

const SCREEN = SCREENS.find((s) => s.path === '/intake')!;

/** The screen for a role the API keeps out of Data intake. */
export function IntakeNoAccess({ role }: { role: string | undefined }) {
  return (
    <div className="px-8 py-8">
      <section
        aria-labelledby="intake-no-access"
        className="bg-card mx-auto flex max-w-xl flex-col items-center gap-3 rounded-lg border px-8 py-12 text-center shadow-xs"
      >
        <span className="bg-muted text-muted-foreground grid size-11 place-items-center rounded-full">
          <Lock className="size-5" aria-hidden />
        </span>
        <h2 id="intake-no-access" className="text-base font-semibold">
          You don’t have access to Data intake
        </h2>
        <p className="text-muted-foreground text-sm">
          {role ? `As ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${formatRole(role)}, you` : 'You'} can’t upload files here
          or see the files others have uploaded. If you need to, ask an Admin to change your role.
        </p>
        {role === 'control_owner' ? (
          <p className="text-sm">
            Evidence for a control you own is added from that control’s page.{' '}
            <Link to="/controls" className="text-primary font-semibold whitespace-nowrap hover:underline">
              Go to Controls
            </Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function IntakePage({
  search,
  onSearchChange,
}: {
  search: IntakeSearch;
  onSearchChange: (next: IntakeSearch) => void;
}) {
  const me = useMe();
  const role = me.data?.role;
  const clearance = me.data?.clearance ?? '';
  const kinds = role ? uploadKinds(role) : [];
  const { documents, rows, working } = useDocumentRows(search);
  const [highlightId, setHighlightId] = useState<string | undefined>(undefined);

  const header = <PageHeader title={SCREEN.label} summary={SCREEN.summary} />;

  if (isForbidden(documents.error) && !documents.data) {
    return (
      <>
        {header}
        <IntakeNoAccess role={role} />
      </>
    );
  }

  const onUploaded = (answer: PostUploadsResponse) => setHighlightId(answer.document.id);

  return (
    <>
      {header}
      <div className="flex min-w-0 flex-col gap-6 px-8 py-6">
        {kinds.length > 0 ? <UploadPanel kinds={kinds} clearance={clearance} onUploaded={onUploaded} /> : null}
        <DocumentsTable
          rows={rows}
          isPending={documents.isPending}
          isPlaceholderData={documents.isPlaceholderData}
          error={documents.error}
          total={documents.data?.total}
          working={working}
          search={search}
          onSearchChange={onSearchChange}
          kinds={role ? listedKinds(role) : []}
          highlightId={highlightId}
          emptyText={
            kinds.length > 0 ? 'No files have been uploaded yet. Upload one above to get started.' : SCREEN.empty
          }
        />
        {role === 'admin' ? <SampleDataPanel /> : null}
      </div>
    </>
  );
}
