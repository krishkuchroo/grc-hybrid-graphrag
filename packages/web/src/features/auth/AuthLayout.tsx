// The frame around the signed-out screens: the product's chrome colour on the left, the form on the
// right. On narrow screens the left panel folds into a strip above the form.
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/BrandMark';

export function AuthLayout({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="bg-chrome text-chrome-foreground relative flex flex-col justify-between overflow-hidden px-8 py-6 lg:px-12 lg:py-12">
        <BrandMark />
        <div className="hidden max-w-sm lg:block">
          <p className="text-2xl leading-snug font-light text-white">
            Risks, controls and evidence in one connected record, for the people who answer for them.
          </p>
          <p className="text-chrome-muted mt-4 text-sm leading-relaxed">
            Sign-in uses a password and a code from your authenticator app, for everyone.
          </p>
        </div>
        <p className="text-chrome-muted hidden text-xs lg:block">Integrated risk management</p>
        <div aria-hidden className="bg-brand absolute inset-y-0 right-0 hidden w-1 lg:block" />
      </aside>
      <main className="flex items-start justify-center px-6 py-10 sm:items-center lg:px-16">
        <div className="w-full max-w-md">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">{title}</h1>
          {lead ? <div className="text-muted-foreground mt-2 text-sm leading-relaxed">{lead}</div> : null}
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
