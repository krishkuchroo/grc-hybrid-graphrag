// The one chat session of the signed-in frame (D262): the quick panel (./ChatPanel), the Ask page
// (./AskPage) and the menu's Ask all read the same session, so the open conversation, the question
// being written and an answer still arriving carry across between them. The shell (AppShell) holds
// the provider inside its route, so signing out unmounts it, stops a running answer, and the next
// person starts with nothing. Nothing but this provider calls useChatSession().
import { createContext, useContext, type ReactNode } from 'react';
import { useChatSession, type ChatSession } from './useChatSession';

const ChatSessionContext = createContext<ChatSession | null>(null);

export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const session = useChatSession();
  return <ChatSessionContext.Provider value={session}>{children}</ChatSessionContext.Provider>;
}

/** The shell's chat session. Outside ChatSessionProvider there is none, and that is a bug. */
export function useSharedChatSession(): ChatSession {
  const session = useContext(ChatSessionContext);
  if (session === null) throw new Error('useSharedChatSession() was called outside ChatSessionProvider.');
  return session;
}
