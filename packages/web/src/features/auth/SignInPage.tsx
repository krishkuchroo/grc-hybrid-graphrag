// Sign-in (D54): email and password, checked here for shape only (the API decides). A person with
// MFA goes on to the 6-digit check; a person without it goes to MFA set-up.
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Clock, LockKeyhole, TriangleAlert } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { AuthLayout } from '@/features/auth/AuthLayout';
import { ME_KEY, problemText } from '@/features/auth/session';

export const MIN_PASSWORD_LENGTH = 12;

const signInSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').pipe(z.email('Enter a valid email address.')),
  password: z
    .string()
    .min(1, 'Enter your password.')
    .min(MIN_PASSWORD_LENGTH, `Passwords have at least ${MIN_PASSWORD_LENGTH} characters.`),
});

type SignInValues = z.infer<typeof signInSchema>;

function lockedText(err: ApiError): string {
  if (err.retryAfterSeconds) {
    return `Too many failed sign-ins. Try again in ${Math.ceil(err.retryAfterSeconds / 60)} min.`;
  }
  return err.message;
}

export function SignInPage({ idle = false }: { idle?: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  });

  const signIn = useMutation({
    mutationFn: (values: SignInValues) => api.postAuthSignInEmail(values),
    onSuccess: async (result) => {
      queryClient.removeQueries({ queryKey: ME_KEY });
      if ('twoFactorRedirect' in result) await navigate({ to: '/sign-in/verify' });
      else await navigate({ to: '/mfa/setup' });
    },
  });

  const error = signIn.error;
  const locked = error instanceof ApiError && error.status === 429;

  return (
    <AuthLayout title="Sign in" lead="Use the work email your administrator registered for you.">
      <div className="grid gap-6">
        {idle && !error ? (
          <Alert variant="info" role="status">
            <Clock aria-hidden />
            <AlertTitle>Signed out</AlertTitle>
            <AlertDescription>
              <p>You were signed out after 30 minutes of inactivity. Sign in again to carry on.</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" role="alert">
            {locked ? <LockKeyhole aria-hidden /> : <TriangleAlert aria-hidden />}
            <AlertTitle>{locked ? 'Account locked' : 'Sign-in failed'}</AlertTitle>
            <AlertDescription>
              <p>{locked ? lockedText(error) : problemText(error)}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        <Form {...form}>
          <form noValidate className="grid gap-5" onSubmit={form.handleSubmit((values) => signIn.mutate(values))}>
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="username" spellCheck={false} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
            <Button type="submit" size="lg" className="mt-1 w-full" disabled={signIn.isPending}>
              Sign in
            </Button>
          </form>
        </Form>
      </div>
    </AuthLayout>
  );
}
