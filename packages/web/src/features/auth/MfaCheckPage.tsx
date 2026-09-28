// The second step of sign-in for a person with MFA (D54): a 6-digit authenticator code, or a
// backup code instead. The device is never trusted, so the check comes every time.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { AuthLayout } from '@/features/auth/AuthLayout';
import { CodeForm, type CodeKind } from '@/features/auth/CodeForm';
import { ME_KEY } from '@/features/auth/session';

export function MfaCheckPage() {
  const [kind, setKind] = useState<CodeKind>('totp');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const verify = useMutation({
    mutationFn: ({ kind, code }: { kind: CodeKind; code: string }) =>
      kind === 'totp' ? api.postAuthTwoFactorVerifyTotp({ code }) : api.postAuthTwoFactorVerifyBackupCode({ code }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ME_KEY });
      await navigate({ to: '/' });
    },
  });

  function switchTo(next: CodeKind) {
    verify.reset();
    setKind(next);
  }

  return (
    <AuthLayout
      title="Check it's you"
      lead={
        kind === 'totp'
          ? 'Open your authenticator app and enter the 6-digit code shown for GRC.'
          : 'Enter one of the backup codes you saved when you set up two-factor sign-in.'
      }
    >
      <CodeForm
        key={kind}
        kind={kind}
        submitLabel="Verify"
        pending={verify.isPending}
        error={verify.error}
        onSubmit={(code) => verify.mutate({ kind, code })}
        footer={
          <div className="grid gap-4">
            <Separator />
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              {kind === 'totp' ? (
                <Button type="button" variant="link" className="h-auto px-0" onClick={() => switchTo('backup')}>
                  Use a backup code
                </Button>
              ) : (
                <Button type="button" variant="link" className="h-auto px-0" onClick={() => switchTo('totp')}>
                  Use your authenticator app
                </Button>
              )}
              <Link
                to="/sign-in"
                className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              >
                Back to sign-in
              </Link>
            </div>
          </div>
        }
      />
    </AuthLayout>
  );
}
