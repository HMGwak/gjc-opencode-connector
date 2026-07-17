export type SequencedMessage<T> = { seq: number; message: T };

export type VisibleConversationMessage = { role: "user" | "assistant"; text: string };

export function visibleConversationMessage(eventType: string, payload: unknown): VisibleConversationMessage | null {
  if (eventType !== "gjc.message" || typeof payload !== "object" || payload === null) return null;
  const { role, text } = payload as { role?: unknown; text?: unknown };
  if ((role !== "user" && role !== "assistant") || typeof text !== "string") return null;
  return text.trim().length > 0 ? { role, text } : null;
}

export function responseCursor(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : null;
}

export function parseSseDataFrames(body: string): unknown[] {
  const events: unknown[] = [];
  for (const frame of body.split(/\n\n+/)) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) continue;
    events.push(JSON.parse(data));
  }
  return events;
}

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
