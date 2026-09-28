// The create and edit form for any record kind (React Hook Form). It checks the values with the
// shared S1-001 schemas before anything is sent, and shows each problem on its field. Name, owner
// and label are on every form; each kind adds its own fields. The owner picker is on both forms,
// for everyone the form is open to (D206); the label chooser offers only what the caller passes in
// (the canChangeLabel changes at or below the clearance, D51, D198). The API still decides (D7).
import { createSchemas, type Label, type RecordKind } from '@grc/shared';
import type { ReactNode } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { words } from './format';
import { OwnerPicker } from './OwnerPicker';

export interface FormFieldDef {
  /** The API's field name. */
  name: string;
  label: string;
  /** `date` is a day (`2026-06-30`); `datetime` a moment in the person's own time, sent as ISO 8601. */
  control: 'text' | 'integer' | 'select' | 'date' | 'datetime';
  /** For a select: the stored values and what they read as. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** A select whose values are whole numbers (for example impact 1–5). */
  integer?: boolean;
  /** What to fix, shown when the shared schema refuses the value. */
  message: string;
  description?: string;
  placeholder?: string;
}

/** Every value as the form holds it: text, before conversion. */
export type FormValues = Record<string, string>;

export interface FormResult {
  /** Every field, converted as the API takes it. */
  all: Record<string, unknown>;
  /** Only the fields changed from the starting values (for an edit). */
  changed: Record<string, unknown>;
}

const COMMON_MESSAGES: Record<string, string> = {
  name: 'Enter a name.',
  owner: 'Choose an owner from the list.',
  label: 'Choose a label.',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** A stored moment as a date-and-time input holds it: the person's own time, to the minute. */
export function toLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A date-and-time input's value as the API takes it (ISO 8601 in UTC); left as typed if it isn't one. */
function fromLocalDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function convert(fields: readonly FormFieldDef[], values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = { name: values.name ?? '' };
  if (values.owner) out.owner = values.owner;
  if (values.label) out.label = values.label;
  for (const field of fields) {
    const raw = (values[field.name] ?? '').trim();
    if (field.control === 'integer' || field.integer) out[field.name] = raw === '' ? undefined : Number(raw);
    else if (field.control === 'datetime') out[field.name] = raw === '' ? undefined : fromLocalDateTime(raw);
    else out[field.name] = raw === '' ? undefined : raw;
  }
  return out;
}

interface Props {
  kind: RecordKind;
  mode: 'create' | 'edit';
  fields: readonly FormFieldDef[];
  initial: FormValues;
  labelChoices: readonly Label[];
  submitText: string;
  pending: boolean;
  onSubmit: (result: FormResult) => void;
  onCancel: () => void;
  /** A problem from the API (refusal, stale save), shown above the fields. */
  notice?: ReactNode;
}

export function RecordForm({
  kind,
  mode,
  fields,
  initial,
  labelChoices,
  submitText,
  pending,
  onSubmit,
  onCancel,
  notice,
}: Props) {
  const messages: Record<string, string> = {
    ...COMMON_MESSAGES,
    ...Object.fromEntries(fields.map((f) => [f.name, f.message])),
  };

  const resolver: Resolver<FormValues> = async (values) => {
    const checked = createSchemas[kind].safeParse(convert(fields, values));
    if (checked.success) return { values, errors: {} };
    const errors: FieldErrors<FormValues> = {};
    for (const issue of checked.error.issues) {
      const key = String(issue.path[0] ?? 'name');
      errors[key] ??= { type: issue.code, message: messages[key] ?? issue.message };
    }
    return { values: {}, errors };
  };

  const form = useForm<FormValues>({ resolver, defaultValues: initial, mode: 'onSubmit', reValidateMode: 'onChange' });

  const submit = form.handleSubmit((values) => {
    const all = convert(fields, values);
    const before = convert(fields, initial);
    const changed = Object.fromEntries(Object.entries(all).filter(([key, value]) => before[key] !== value));
    onSubmit({ all, changed });
  });

  return (
    <Form {...form}>
      <form noValidate onSubmit={submit} className="grid gap-6">
        {notice}
        <fieldset className="grid gap-x-6 gap-y-5 sm:grid-cols-2" disabled={pending}>
          <legend className="sr-only">{mode === 'create' ? 'New record' : 'Edit record'}</legend>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>
                  Name
                  <span className="text-destructive" aria-hidden>
                    *
                  </span>
                </FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {fields.map((def) => (
            <FormField
              key={def.name}
              control={form.control}
              name={def.name}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {def.label}
                    <span className="text-destructive" aria-hidden>
                      *
                    </span>
                  </FormLabel>
                  <FormControl>
                    {def.control === 'select' ? (
                      <NativeSelect {...field}>
                        <option value="">{def.placeholder ?? 'Choose…'}</option>
                        {(def.options ?? []).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : def.control === 'date' || def.control === 'datetime' ? (
                      <Input type={def.control === 'date' ? 'date' : 'datetime-local'} className="w-auto" {...field} />
                    ) : (
                      <Input
                        autoComplete="off"
                        inputMode={def.control === 'integer' ? 'numeric' : undefined}
                        placeholder={def.placeholder}
                        {...field}
                      />
                    )}
                  </FormControl>
                  {def.description ? <FormDescription>{def.description}</FormDescription> : null}
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}

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
                <FormDescription>The person accountable for this record.</FormDescription>
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
