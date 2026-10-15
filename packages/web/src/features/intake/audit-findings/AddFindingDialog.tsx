// "Add audit finding" on a control or risk page (D213 (2), (4)), and the finding form it shares with
// the finding's own page. The form has every D213 (2) field: title, severity, status, owner, source
// or audit reference, root cause, remediation plan, date identified, due date, the closed date
// (shown, and required, only when the status is Closed, R15), an optional description and the
// label. It checks the values with S3-002's schemas (with the person's today) before anything is
// sent, and shows each problem on its field, the date rules in their own words. The record the
// dialog opens from is the finding's concern (`concernsId`, R11), so saving makes the finding and
// its CONCERNS link together. The API decides (D7): its refusals show above the fields.
import { intakeCreateSchemasOn, intakeUpdateSchemasOn, findingDateProblems, FINDING_SEVERITIES } from '@grc/shared';
import { Link } from '@tanstack/react-router';
import { CircleCheck, ClipboardPlus, SearchX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm, useWatch, type FieldErrors, type Resolver } from 'react-hook-form';
import { ApiError, type PostAuditFindingsBody } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ApiProblem } from '@/features/records/ApiProblem';
import { choices, words } from '@/features/records/format';
import { OwnerPicker } from '@/features/records/OwnerPicker';
import type { Viewer } from '@/features/records/permissions';
import type { AnyRecord } from '@/features/records/useRecords';
import {
  FINDING_STATUS_CHOICES,
  findingLabelChoices,
  localToday,
  startingFindingLabel,
  useCreateFinding,
  type ConcernKind,
  type Finding,
} from './useFindings';

/** Every value as the form holds it: text, before conversion. */
export type FindingFormValues = Record<FindingField, string>;

type FindingField =
  | 'name'
  | 'severity'
  | 'findingStatus'
  | 'owner'
  | 'label'
  | 'sourceReference'
  | 'rootCause'
  | 'remediationPlan'
  | 'identifiedDate'
  | 'dueDate'
  | 'closedDate'
  | 'description';

export interface FindingFormResult {
  /** Every field, converted as the API takes it (no closed date unless the status is Closed). */
  all: Record<string, unknown>;
  /** Only the fields changed from the starting values (for an edit). */
  changed: Record<string, unknown>;
}

/** What to fix, by field, when the shared schema refuses a value. */
const MESSAGES: Record<FindingField, string> = {
  name: 'Enter a title.',
  severity: 'Choose a severity.',
  findingStatus: 'Choose a status.',
  owner: 'Choose an owner from the list.',
  label: 'Choose a label.',
  sourceReference: 'Enter the source or audit reference, up to 200 characters.',
  rootCause: 'Enter the root cause, up to 4,000 characters.',
  remediationPlan: 'Enter the remediation plan, up to 4,000 characters.',
  identifiedDate: 'Enter the date the finding was identified.',
  dueDate: 'Enter the due date.',
  closedDate: 'Enter the closed date.',
  description: 'Keep the description to 4,000 characters or fewer.',
};

/** The date rules (R15), each in the field's own words. */
const DATE_MESSAGES: Record<string, string> = {
  'identifiedDate:in_future': 'Date identified can’t be after today.',
  'dueDate:before_identified': 'Due date must be on or after the date identified.',
  'closedDate:required': 'Enter the closed date. It’s required when the status is Closed.',
  'closedDate:not_allowed': 'A closed date is allowed only when the status is Closed.',
  'closedDate:before_identified': 'Closed date must be on or after the date identified.',
  'closedDate:in_future': 'Closed date can’t be after today.',
};

const FIELDS = Object.keys(MESSAGES) as FindingField[];

/** The form's starting values for a new finding: the person as owner and the starting label. */
export function emptyFindingValues(viewer: Viewer): FindingFormValues {
  return {
    name: '',
    severity: '',
    findingStatus: 'open',
    owner: viewer.userId,
    label: startingFindingLabel(viewer),
    sourceReference: '',
    rootCause: '',
    remediationPlan: '',
    identifiedDate: localToday(),
    dueDate: '',
    closedDate: '',
    description: '',
  };
}

/** A stored finding as the form holds it. */
export function findingValues(finding: Finding): FindingFormValues {
  return {
    name: finding.name,
    severity: finding.severity,
    findingStatus: finding.findingStatus,
    owner: finding.owner,
    label: finding.label,
    sourceReference: finding.sourceReference,
    rootCause: finding.rootCause,
    remediationPlan: finding.remediationPlan,
    identifiedDate: finding.identifiedDate,
    dueDate: finding.dueDate,
    closedDate: finding.closedDate ?? '',
    description: finding.description ?? '',
  };
}

const text = (value: string | undefined) => {
  const t = (value ?? '').trim();
  return t === '' ? undefined : t;
};

/** The values as the API takes them. A closed date goes only with the Closed status; otherwise it's
 * `null`, so an edit that reopens a finding clears it. An empty description is `null` too. */
function convert(values: Partial<FindingFormValues>): Record<string, unknown> {
  const status = text(values.findingStatus);
  return {
    name: values.name ?? '',
    severity: text(values.severity),
    findingStatus: status,
    owner: text(values.owner),
    label: text(values.label),
    sourceReference: text(values.sourceReference),
    rootCause: text(values.rootCause),
    remediationPlan: text(values.remediationPlan),
    identifiedDate: text(values.identifiedDate),
    dueDate: text(values.dueDate),
    closedDate: status === 'closed' ? (text(values.closedDate) ?? null) : null,
    description: text(values.description) ?? null,
  };
}

/** Without the empty values: what a create sends. */
function present(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
}

interface FormProps {
  mode: 'create' | 'edit';
  initial: FindingFormValues;
  /** The control or risk a new finding concerns (create only). */
  concernsId?: string;
  /** The version the edit started from (edit only). */
  version?: number;
  labelChoices: readonly string[];
  submitText: string;
  pending: boolean;
  onSubmit: (result: FindingFormResult) => void;
  onCancel: () => void;
  /** A problem from the API (refusal, stale save), shown above the fields. */
  notice?: ReactNode;
}

function Required() {
  return (
    <span className="text-destructive" aria-hidden>
      *
    </span>
  );
}

export function FindingForm({
  mode,
  initial,
  concernsId,
  version,
  labelChoices,
  submitText,
  pending,
  onSubmit,
  onCancel,
  notice,
}: FormProps) {
  const resolver: Resolver<FindingFormValues> = async (values) => {
    const today = localToday();
    const body = convert(values);
    const errors: FieldErrors<FindingFormValues> = {};
    const put = (field: string, type: string, message: string) => {
      if (!FIELDS.includes(field as FindingField)) return;
      errors[field as FindingField] ??= { type, message };
    };
    // The date rules first, so each shows in its own words (R15).
    for (const p of findingDateProblems(
      {
        findingStatus: String(body.findingStatus ?? ''),
        identifiedDate: String(body.identifiedDate ?? ''),
        dueDate: String(body.dueDate ?? ''),
        closedDate: (body.closedDate as string | null) ?? null,
      },
      today,
    )) {
      put(p.field, p.code, DATE_MESSAGES[`${p.field}:${p.code}`] ?? MESSAGES[p.field]);
    }
    const checked =
      mode === 'create'
        ? intakeCreateSchemasOn(today).audit_finding.safeParse({ ...present(body), concernsId })
        : intakeUpdateSchemasOn(today).audit_finding.safeParse({ ...body, version });
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        const key = String(issue.path[0] ?? 'name');
        put(key, issue.code, MESSAGES[key as FindingField] ?? issue.message);
      }
    }
    if (Object.keys(errors).length > 0) return { values: {}, errors };
    return { values, errors: {} };
  };

  const form = useForm<FindingFormValues>({
    resolver,
    defaultValues: initial,
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const status = useWatch({ control: form.control, name: 'findingStatus' });
  const closed = status === 'closed';

  const submit = form.handleSubmit((values) => {
    const all = convert(values);
    const before = convert(initial);
    const changed = Object.fromEntries(Object.entries(all).filter(([key, value]) => before[key] !== value));
    onSubmit({ all: mode === 'create' ? present(all) : all, changed });
  });

  return (
    <Form {...form}>
      <form noValidate onSubmit={submit} className="grid gap-6">
        {notice}
        <fieldset className="grid gap-x-6 gap-y-5 sm:grid-cols-2" disabled={pending}>
          <legend className="sr-only">{mode === 'create' ? 'New audit finding' : 'Edit audit finding'}</legend>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>
                  Title
                  <Required />
                </FormLabel>
                <FormControl>
                  <Input autoComplete="off" placeholder="What the audit found, in a line" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="severity"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Severity
                  <Required />
                </FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    <option value="">Choose…</option>
                    {choices(FINDING_SEVERITIES).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="findingStatus"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Status
                  <Required />
                </FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    <option value="">Choose…</option>
                    {FINDING_STATUS_CHOICES.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="identifiedDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Date identified
                  <Required />
                </FormLabel>
                <FormControl>
                  <Input type="date" className="w-auto" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="dueDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Due date
                  <Required />
                </FormLabel>
                <FormControl>
                  <Input type="date" className="w-auto" {...field} />
                </FormControl>
                <FormDescription>When the remediation should be done.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {closed ? (
            <FormField
              control={form.control}
              name="closedDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Closed date
                    <Required />
                  </FormLabel>
                  <FormControl>
                    <Input type="date" className="w-auto" {...field} />
                  </FormControl>
                  <FormDescription>The day the finding was closed.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}

          <FormField
            control={form.control}
            name="sourceReference"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>
                  Source or audit reference
                  <Required />
                </FormLabel>
                <FormControl>
                  <Input autoComplete="off" placeholder="e.g. FY26 SOC 2 Type II, item 14" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="rootCause"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>
                  Root cause
                  <Required />
                </FormLabel>
                <FormControl>
                  <Textarea rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="remediationPlan"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>
                  Remediation plan
                  <Required />
                </FormLabel>
                <FormControl>
                  <Textarea rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>
                  Description <span className="text-muted-foreground font-normal">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Textarea rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="owner"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Owner</FormLabel>
                <FormControl>
                  <OwnerPicker
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ''}
                    onValueChange={field.onChange}
                  />
                </FormControl>
                <FormDescription>The person accountable for the remediation.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Label</FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    {labelChoices.map((label) => (
                      <option key={label} value={label}>
                        {words(label)}
                      </option>
                    ))}
                  </NativeSelect>
                </FormControl>
                <FormDescription>Who can see it: only people cleared for this label or higher.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </fieldset>

        <div className="flex items-center gap-2 border-t pt-4">
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : submitText}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
    </Form>
  );
}

/** The API's refusal of a new finding, in plain words. */
function CreateRefusal({ error, noun }: { error: unknown; noun: string }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Alert variant="destructive" role="alert">
        <SearchX aria-hidden />
        <AlertTitle>The audit finding wasn&apos;t added</AlertTitle>
        <AlertDescription>
          <p>This {noun} doesn&apos;t exist or you can&apos;t see it.</p>
        </AlertDescription>
      </Alert>
    );
  }
  const title =
    error instanceof ApiError && error.status === 403
      ? 'You can’t add this audit finding'
      : 'The audit finding wasn’t added';
  return <ApiProblem error={error} title={title} />;
}

export function AddFindingDialog({
  record,
  noun,
  viewer,
  onAdded,
}: {
  record: AnyRecord;
  /** "control" or "risk". */
  noun: string;
  viewer: Viewer;
  /** Called with the new finding once it's saved. */
  onAdded: (finding: Finding) => void;
}) {
  const [open, setOpen] = useState(false);
  /** A new form each time the dialog opens, so nothing typed before is kept. */
  const [round, setRound] = useState(0);
  const create = useCreateFinding();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (create.isPending) return;
        if (next) {
          create.reset();
          setRound((r) => r + 1);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <ClipboardPlus aria-hidden />
          Add audit finding
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardPlus className="text-primary size-4" aria-hidden />
            Add audit finding
          </DialogTitle>
          <DialogDescription>
            The finding will concern {noun}{' '}
            <span className="text-foreground font-semibold tabular-nums">{record.number}</span> {record.name}. You can
            link more controls and risks from the finding&apos;s page. The number is given when you add it; fields
            marked * are required.
          </DialogDescription>
        </DialogHeader>
        <FindingForm
          key={round}
          mode="create"
          initial={emptyFindingValues(viewer)}
          concernsId={record.id}
          labelChoices={findingLabelChoices(viewer)}
          submitText="Add audit finding"
          pending={create.isPending}
          notice={create.error ? <CreateRefusal error={create.error} noun={noun} /> : null}
          onCancel={() => setOpen(false)}
          onSubmit={({ all }) =>
            create.mutate({ ...all, concernsId: record.id } as PostAuditFindingsBody, {
              onSuccess: (finding) => {
                setOpen(false);
                onAdded(finding);
              },
            })
          }
        />
      </DialogContent>
    </Dialog>
  );
}

/** The confirmation after a new finding, with the way to its page. */
export function FindingAdded({
  finding,
  kind,
  className,
}: {
  finding: Finding;
  kind: ConcernKind;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <CircleCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
      <span className="truncate">
        <Link
          to="/audit-findings/$id"
          params={{ id: finding.id }}
          className="text-primary font-semibold tabular-nums underline-offset-2 hover:underline"
        >
          {finding.number}
        </Link>{' '}
        was added and concerns this {kind}.
      </span>
    </span>
  );
}
