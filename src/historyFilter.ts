export interface SearchableMessage {
  text?: string;
  thoughtText?: string;
}

export interface SearchableConversation {
  id: string;
  title?: string;
  messages: SearchableMessage[];
  pinned?: boolean;
}

/**
 * Filter conversations by title and message body (and thought text).
 * Empty query returns all items (caller may still sort/pin).
 */
export function filterConversationsByQuery<T extends SearchableConversation>(
  conversations: T[],
  query: string,
): T[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return conversations;
  return conversations.filter((item) => conversationMatchesQuery(item, q));
}

export function conversationMatchesQuery(
  conversation: SearchableConversation,
  normalizedQuery: string,
): boolean {
  const q = normalizedQuery.trim().toLocaleLowerCase();
  if (!q) return true;
  const title = (conversation.title || "未命名对话").toLocaleLowerCase();
  if (title.includes(q)) return true;
  for (const message of conversation.messages ?? []) {
    if ((message.text ?? "").toLocaleLowerCase().includes(q)) return true;
    if ((message.thoughtText ?? "").toLocaleLowerCase().includes(q)) return true;
  }
  return false;
}

/** Sort: pinned first (stable by updatedAt if provided via optional field). */
export function sortConversationsForHistory<T extends SearchableConversation & { updatedAt?: number }>(
  conversations: T[],
): T[] {
  return [...conversations].sort((a, b) => {
    const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pin !== 0) return pin;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}
