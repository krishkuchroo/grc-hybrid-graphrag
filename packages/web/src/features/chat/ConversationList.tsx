// The person's own conversations (S6-007 behaviour 2), latest activity first, a page at a time
// with "Load more", and "New conversation". Picking one opens it in the panel.
import { MessagesSquare, SquarePen } from 'lucide-react';
import { forwardRef } from 'react';
import { Button } from '@/components/ui/button';
import { ApiProblem } from '@/features/records/ApiProblem';
import { cn } from '@/lib/utils';
import { useConversationList } from './useChat';
import { counted, lastUsedText } from './words';

interface ConversationListProps {
  currentId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
}

export const ConversationList = forwardRef<HTMLButtonElement, ConversationListProps>(function ConversationList(
  { currentId, onOpen, onNew },
  newButtonRef,
) {
  const list = useConversationList(true);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;

  return (
    <div className="grid content-start gap-3 px-4 py-4">
      <Button ref={newButtonRef} type="button" variant="outline" className="justify-start" onClick={onNew}>
        <SquarePen aria-hidden />
        New conversation
      </Button>

      {list.isPending ? (
        <ul aria-label="Loading conversations" className="grid gap-2">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="bg-card grid gap-2 rounded-md border px-3 py-3">
              <span className="bg-muted h-3.5 w-3/4 animate-pulse rounded-sm" />
              <span className="bg-muted h-3 w-1/3 animate-pulse rounded-sm" />
            </li>
          ))}
        </ul>
      ) : list.data === undefined ? (
        <ApiProblem error={list.error} title="Your conversations couldn't be loaded">
          <Button type="button" size="sm" variant="outline" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </ApiProblem>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-center text-sm">
          <MessagesSquare className="size-5" aria-hidden />
          <p>No conversations yet. Your first question starts one.</p>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            {rows.length < total
              ? `${rows.length} of ${total} conversations`
              : counted(total, 'conversation', 'conversations')}
          </p>
          <ul className="bg-card divide-y overflow-hidden rounded-md border">
            {rows.map((row) => {
              const current = row.id === currentId;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    onClick={() => onOpen(row.id)}
                    className={cn(
                      'hover:bg-accent/60 focus-visible:bg-accent relative grid w-full gap-0.5 px-3 py-2.5 text-left focus-visible:outline-none',
                      current &&
                        'bg-accent/70 before:bg-primary before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full',
                    )}
                  >
                    <span className="truncate text-sm font-semibold">{row.title}</span>
                    <span className="text-muted-foreground flex gap-3 text-xs">
                      <span>
                        {row.messageCount === 0
                          ? 'No questions yet'
                          : counted(row.messageCount, 'question', 'questions')}
                      </span>
                      <time dateTime={row.lastActivityAt} className="ml-auto tabular-nums">
                        {lastUsedText(row.lastActivityAt)}
                      </time>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {list.hasNextPage ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-center"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
          {list.isFetchNextPageError ? (
            <ApiProblem error={list.error} title="More conversations couldn't be loaded" />
          ) : null}
        </>
      )}
    </div>
  );
});
