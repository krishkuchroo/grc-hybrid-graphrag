// The Ask page's welcome (D262), for an empty new conversation on the page only (the quick panel
// keeps its own short note): a greeting with the person's first name, a line on what Ask answers
// from, and four starter questions as cards. A card asks its question at once; the cards wait, like
// the question box, while a conversation is being started or an answer written, and during the
// 10-a-minute wait, so a click never silently does nothing. The Warrant mark draws itself in once
// above the greeting, and a large, faint copy of it sits behind the page like a letterhead's
// watermark; both are decoration only (aria-hidden).
import { SendHorizontal } from 'lucide-react';
import { useId } from 'react';
import { WarrantGlyph } from '@/components/BrandMark';
import { ASK_WELCOME_TEXT, RECORD_KIND_ICON, STARTER_QUESTIONS } from './words';

export function AskWelcome({
  firstName,
  disabled,
  onAsk,
}: {
  firstName: string | undefined;
  /** The cards wait: the box is busy or the 10-a-minute wait is on. */
  disabled: boolean;
  onAsk: (question: string) => void;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="relative isolate flex min-h-full flex-col justify-center overflow-hidden"
    >
      <WarrantGlyph
        strokeWidth={1.15}
        className="text-primary/5 pointer-events-none absolute -right-32 -bottom-36 -z-10 hidden size-[36rem] md:block"
      />
      <div className="mx-auto grid w-full max-w-[48rem] gap-9 px-4 py-12 sm:px-6">
        <div className="grid gap-6">
          <span
            aria-hidden
            className="bg-chrome text-brand grid size-12 place-items-center rounded-xl shadow-[0_10px_24px_-12px_rgba(21,38,47,0.65)]"
          >
            <WarrantGlyph drawn strokeWidth={2.5} className="size-7" />
          </span>
          <div className="grid gap-3">
            <h2
              id={headingId}
              className="text-foreground text-[1.75rem] leading-[1.15] font-light tracking-[-0.015em] text-balance sm:text-[2.125rem]"
            >
              {ASK_WELCOME_TEXT.greeting(firstName)}
            </h2>
            <p className="text-muted-foreground max-w-[56ch] text-[15px] leading-relaxed">{ASK_WELCOME_TEXT.lead}</p>
          </div>
        </div>

        <ul aria-label={ASK_WELCOME_TEXT.starters} className="grid gap-3 sm:grid-cols-2">
          {STARTER_QUESTIONS.map((starter) => {
            const Icon = RECORD_KIND_ICON[starter.kind];
            return (
              <li key={starter.question} className="flex">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onAsk(starter.question)}
                  className="group bg-card hover:border-primary/45 focus-visible:border-ring focus-visible:ring-ring/50 flex w-full items-center gap-3.5 rounded-lg border px-4 py-3.5 text-left shadow-xs transition-colors outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-55"
                >
                  <span
                    aria-hidden
                    className="bg-accent text-primary group-hover:bg-primary group-focus-visible:bg-primary grid size-9 shrink-0 place-items-center rounded-md transition-colors group-hover:text-white group-focus-visible:text-white"
                  >
                    <Icon className="size-[18px]" />
                  </span>
                  <span className="text-foreground min-w-0 flex-1 text-[15px] leading-snug font-semibold">
                    {starter.question}
                  </span>
                  <SendHorizontal
                    aria-hidden
                    className="text-muted-foreground/50 group-hover:text-primary group-focus-visible:text-primary size-4 shrink-0 transition-colors"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
