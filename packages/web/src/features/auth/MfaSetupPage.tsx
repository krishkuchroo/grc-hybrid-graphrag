// MFA set-up for a person who has none yet (D54). Four steps, in order:
//   1. confirm the password (the API needs it to start set-up; the app never keeps a password),
//   2. scan the QR code into an authenticator app,
//   3. save the backup codes, shown this once,
//   4. confirm with a code from the app.
// The QR secret and the backup codes live only in this page's memory, never in browser storage,
// and are gone once the page closes.
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, type PostAuthTwoFactorEnableResponse } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthLayout } from '@/features/auth/AuthLayout';
import { CodeForm } from '@/features/auth/CodeForm';
import { ME_KEY, problemText } from '@/features/auth/session';
import { cn } from '@/lib/utils';

type Step = 'password' | 'scan' | 'codes' | 'confirm';

const STEPS: { id: Step; label: string }[] = [
  { id: 'password', label: 'Your password' },
  { id: 'scan', label: 'Scan' },
  { id: 'codes', label: 'Backup codes' },
  { id: 'confirm', label: 'Check' },
];

function Steps({ current }: { current: Step }) {
  const at = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="mb-8 grid grid-cols-4 gap-2" aria-label="Set-up progress">
      {STEPS.map((step, i) => (
        <li key={step.id} aria-current={i === at ? 'step' : undefined} className="grid gap-2">
          <span
            className={cn('h-1 rounded-full', i < at ? 'bg-primary' : i === at ? 'bg-brand' : 'bg-border')}
            aria-hidden
          />
          <span className={cn('text-xs', i === at ? 'text-foreground font-semibold' : 'text-muted-foreground')}>
            {i + 1}. {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function secretFrom(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get('secret');
  } catch {
    return null;
  }
}

const passwordSchema = z.object({ password: z.string().min(1, 'Enter your password.') });

function PasswordStep({ onEnabled }: { onEnabled: (result: PostAuthTwoFactorEnableResponse) => void }) {
  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { password: '' },
  });
  const enable = useMutation({
    mutationFn: (password: string) => api.postAuthTwoFactorEnable({ password }),
    onSuccess: (result) => {
      form.reset();
      onEnabled(result);
    },
  });
  return (
    <div className="grid gap-6">
      {enable.error ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert aria-hidden />
          <AlertTitle>Set-up didn&apos;t start</AlertTitle>
          <AlertDescription>
            <p>{problemText(enable.error)}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      <Form {...form}>
        <form
          noValidate
          className="grid gap-5"
          onSubmit={form.handleSubmit((values) => enable.mutate(values.password))}
        >
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="current-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" size="lg" className="w-full" disabled={enable.isPending}>
            Continue
          </Button>
        </form>
      </Form>
    </div>
  );
}

function ScanStep({ uri, onNext }: { uri: string; onNext: () => void }) {
  const secret = secretFrom(uri);
  return (
    <div className="grid gap-6">
      <div className="flex flex-col items-center gap-5 rounded-lg border bg-card p-6 sm:flex-row sm:items-start">
        <div className="rounded-md border bg-white p-3">
          <QRCodeSVG value={uri} size={168} role="img" aria-label="QR code for your authenticator app" />
        </div>
        <div className="grid gap-3 text-sm">
          <p className="leading-relaxed">
            Scan this with an authenticator app such as Microsoft Authenticator, Google Authenticator or 1Password.
          </p>
          {secret ? (
            <div className="grid gap-1">
              <span className="text-muted-foreground">Can&apos;t scan it? Enter this key instead:</span>
              <code className="bg-muted rounded px-2 py-1 font-mono text-xs break-all select-all">
                {secret.replace(/(.{4})/g, '$1 ').trim()}
              </code>
            </div>
          ) : null}
        </div>
      </div>
      <Button type="button" size="lg" className="w-full" onClick={onNext}>
        Continue
      </Button>
    </div>
  );
}

function CodesStep({ codes, onNext }: { codes: string[]; onNext: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="grid gap-6">
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-sm font-semibold">{codes.length} backup codes</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-4 font-mono text-sm">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Each code signs you in once if you lose your phone. They won&apos;t be shown again, so keep them somewhere safe,
        such as a password manager.
      </p>
      <div className="flex items-center gap-3">
        <Checkbox id="codes-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
        <Label htmlFor="codes-saved" className="font-normal">
          I have saved these backup codes
        </Label>
      </div>
      <Button type="button" size="lg" className="w-full" disabled={!saved} onClick={onNext}>
        Continue
      </Button>
    </div>
  );
}

export function MfaSetupPage() {
  const [step, setStep] = useState<Step>('password');
  const [enrolment, setEnrolment] = useState<PostAuthTwoFactorEnableResponse | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const confirm = useMutation({
    mutationFn: (code: string) => api.postAuthTwoFactorVerifyTotp({ code }),
    onSuccess: async () => {
      setEnrolment(null);
      queryClient.removeQueries({ queryKey: ME_KEY });
      await navigate({ to: '/' });
    },
  });

  const signOut = useMutation({
    mutationFn: () => api.postAuthSignOut({}),
    onSettled: async () => {
      setEnrolment(null);
      queryClient.clear();
      await navigate({ to: '/sign-in' });
    },
  });

  const leads: Record<Step, string> = {
    password: 'Everyone signs in with a second factor. Confirm your password to begin.',
    scan: 'Add GRC to your authenticator app.',
    codes: 'Save these codes before you go on. They get you in if you lose your phone.',
    confirm: 'Enter the 6-digit code your authenticator app now shows for GRC.',
  };

  return (
    <AuthLayout title="Set up two-factor sign-in" lead={leads[step]}>
      <Steps current={step} />
      {step === 'password' ? (
        <PasswordStep
          onEnabled={(result) => {
            setEnrolment(result);
            setStep('scan');
          }}
        />
      ) : null}
      {step === 'scan' && enrolment ? <ScanStep uri={enrolment.totpURI} onNext={() => setStep('codes')} /> : null}
      {step === 'codes' && enrolment ? (
        <CodesStep codes={enrolment.backupCodes} onNext={() => setStep('confirm')} />
      ) : null}
      {step === 'confirm' ? (
        <CodeForm
          kind="totp"
          submitLabel="Verify and finish"
          pending={confirm.isPending}
          error={confirm.error}
          onSubmit={(code) => confirm.mutate(code)}
        />
      ) : null}
      <div className="mt-8 border-t pt-4 text-sm">
        <Button
          type="button"
          variant="link"
          className="text-muted-foreground h-auto px-0"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign out
        </Button>
      </div>
    </AuthLayout>
  );
}
