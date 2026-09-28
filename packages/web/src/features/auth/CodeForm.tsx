// The one field for a second factor: a 6-digit authenticator code, or a backup code.
// The code is checked for shape here; the API decides whether it is right.
import { zodResolver } from '@hookform/resolvers/zod';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { problemText } from '@/features/auth/session';

export type CodeKind = 'totp' | 'backup';

const schemas = {
  totp: z.object({
    code: z
      .string()
      .transform((v) => v.replace(/\s+/g, ''))
      .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6 digits from your authenticator app.')),
  }),
  backup: z.object({
    code: z.string().trim().min(1, 'Enter one of your backup codes.'),
  }),
};

interface CodeValues {
  code: string;
}

export function CodeForm({
  kind,
  submitLabel,
  pending,
  error,
  onSubmit,
  footer,
}: {
  kind: CodeKind;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (code: string) => void;
  footer?: ReactNode;
}) {
  const form = useForm<CodeValues, unknown, CodeValues>({
    resolver: zodResolver(schemas[kind]) as never,
    defaultValues: { code: '' },
  });

  return (
    <div className="grid gap-6">
      {error ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert aria-hidden />
          <AlertTitle>That code didn&apos;t work</AlertTitle>
          <AlertDescription>
            <p>{problemText(error)}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      <Form {...form}>
        <form noValidate className="grid gap-5" onSubmit={form.handleSubmit((values) => onSubmit(values.code))}>
          <FormField
            control={form.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{kind === 'totp' ? 'Authentication code' : 'Backup code'}</FormLabel>
                <FormControl>
                  {kind === 'totp' ? (
                    <Input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={7}
                      className="h-11 font-mono text-lg tracking-[0.4em]"
                      {...field}
                    />
                  ) : (
                    <Input type="text" autoComplete="off" spellCheck={false} className="h-11 font-mono" {...field} />
                  )}
                </FormControl>
                <FormDescription>
                  {kind === 'totp'
                    ? 'The code changes every 30 seconds.'
                    : 'Each backup code works once. Enter it as it was shown.'}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {submitLabel}
          </Button>
        </form>
      </Form>
      {footer}
    </div>
  );
}
