export type SequencedMessage<T> = { seq: number; message: T };

export function mergeConversationMessages<T>(messages: Map<number, T>, incoming: Iterable<SequencedMessage<T>>): void {
  for (const { seq, message } of incoming) {
    if (!messages.has(seq)) messages.set(seq, message);
  }
}

export function orderedConversationMessages<T>(messages: Map<number, T>): T[] {
  return [...messages.entries()].sort(([left], [right]) => left - right).map(([, message]) => message);
}
export function conversationHistoryState(messageCount: number, historyUnavailable: boolean, hydrating: boolean): string | null {
  if (messageCount > 0) return null;
  if (historyUnavailable) return "Conversation history is no longer available.";
  return hydrating ? "Loading conversation…" : "No conversation messages.";
}
