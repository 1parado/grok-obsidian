import {
  createConversation,
  createInitialChatState,
  type ChatConversation,
  type ChatMessage,
  type PersistedChatState,
} from "./chatTypes";

export class ChatStore {
  private state: PersistedChatState;
  private historyLimit: number;

  constructor(
    stored: PersistedChatState | undefined,
    historyLimit: number,
    includeActiveNote: boolean,
  ) {
    this.historyLimit = Math.max(1, historyLimit);
    this.state = this.normalize(stored, includeActiveNote);
    this.trim();
  }

  get current(): ChatConversation {
    let conversation = this.state.conversations.find(
      (item) => item.id === this.state.currentConversationId,
    );
    if (!conversation) {
      conversation = createConversation(true);
      this.state.conversations.unshift(conversation);
      this.state.currentConversationId = conversation.id;
    }
    return conversation;
  }

  list(): ChatConversation[] {
    return [...this.state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  select(id: string): ChatConversation | null {
    const conversation = this.state.conversations.find((item) => item.id === id) ?? null;
    if (conversation) this.state.currentConversationId = conversation.id;
    return conversation;
  }

  create(includeActiveNote: boolean): ChatConversation {
    const conversation = createConversation(includeActiveNote);
    this.state.conversations.unshift(conversation);
    this.state.currentConversationId = conversation.id;
    this.trim();
    return conversation;
  }

  /** Remove a conversation and return it. Ensures at least one conversation remains. */
  takeDeleted(id: string, includeActiveNote: boolean): ChatConversation | null {
    const removed = this.state.conversations.find((item) => item.id === id) ?? null;
    if (!removed) return null;
    this.state.conversations = this.state.conversations.filter((item) => item.id !== id);
    if (this.state.conversations.length === 0) {
      this.create(includeActiveNote);
    } else if (this.state.currentConversationId === id) {
      this.state.currentConversationId = this.list()[0].id;
    }
    return removed;
  }

  setHistoryLimit(limit: number): void {
    this.historyLimit = Math.max(1, Math.floor(limit));
    this.trim();
  }

  getHistoryLimit(): number {
    return this.historyLimit;
  }

  addMessage(message: ChatMessage): void {
    const conversation = this.current;
    conversation.messages.push(message);
    if (conversation.messages.length > 240) {
      conversation.messages = conversation.messages.slice(-240);
    }
    if (message.role === "user" && conversation.title === "新对话") {
      const title = message.text
        .replace(/@\[\[[^\]]+\]\]/g, "")
        .replace(/@\{[^}]+\}/g, "")
        .replace(/\s+/g, " ")
        .trim();
      conversation.title = (title || message.attachments?.[0]?.name || "图片对话").slice(0, 42);
    }
    conversation.updatedAt = Date.now();
  }

  updateMessage(id: string, patch: Partial<ChatMessage>): ChatMessage | null {
    const message = this.current.messages.find((item) => item.id === id) ?? null;
    if (!message) return null;
    Object.assign(message, patch);
    this.current.updatedAt = Date.now();
    return message;
  }

  removeMessage(id: string): void {
    this.current.messages = this.current.messages.filter((item) => item.id !== id);
    this.current.updatedAt = Date.now();
  }

  truncateFrom(id: string): void {
    const index = this.current.messages.findIndex((item) => item.id === id);
    if (index < 0) return;
    this.current.messages = this.current.messages.slice(0, index);
    if (index === 0) this.current.title = "新对话";
    this.current.updatedAt = Date.now();
  }

  setSessionId(sessionId: string | undefined): void {
    this.current.sessionId = sessionId;
    this.current.updatedAt = Date.now();
  }

  setLastTurnUsedAcp(value: boolean): void {
    this.current.lastTurnUsedAcp = value;
    this.current.updatedAt = Date.now();
  }

  setIncludeActiveNote(value: boolean): void {
    this.current.includeActiveNote = value;
    this.current.updatedAt = Date.now();
  }

  setOpenTabPaths(paths: string[]): void {
    this.current.openTabPaths = Array.from(new Set(paths)).slice(0, 3);
    this.current.updatedAt = Date.now();
  }

  rename(id: string, title: string): boolean {
    const conversation = this.state.conversations.find((item) => item.id === id);
    if (!conversation) return false;
    const next = title.trim().slice(0, 80);
    if (!next) return false;
    conversation.title = next;
    conversation.updatedAt = Date.now();
    return true;
  }

  exportMarkdown(id: string): string | null {
    const conversation = this.state.conversations.find((item) => item.id === id);
    if (!conversation) return null;
    const lines: string[] = [
      `# ${conversation.title || "未命名对话"}`,
      "",
      `> 导出时间：${new Date().toLocaleString()}`,
      "",
    ];
    for (const message of conversation.messages) {
      const role = message.role === "user" ? "用户" : "Grok";
      const status =
        message.status === "cancelled"
          ? "（已停止）"
          : message.status === "error"
            ? "（出错）"
            : "";
      lines.push(`## ${role}${status}`, "", message.text || "_(空)_", "");
      if (message.thoughtText?.trim()) {
        lines.push("<details><summary>思考过程</summary>", "", message.thoughtText, "", "</details>", "");
      }
    }
    return lines.join("\n");
  }

  collectAttachmentPaths(conversation?: ChatConversation): string[] {
    const target = conversation ?? this.current;
    const paths = new Set<string>();
    for (const message of target.messages) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.path) paths.add(attachment.path);
      }
    }
    return Array.from(paths);
  }

  allReferencedAttachmentPaths(): Set<string> {
    const paths = new Set<string>();
    for (const conversation of this.state.conversations) {
      for (const path of this.collectAttachmentPaths(conversation)) paths.add(path);
    }
    return paths;
  }

  serialize(): PersistedChatState {
    return JSON.parse(JSON.stringify(this.state)) as PersistedChatState;
  }

  private normalize(
    stored: PersistedChatState | undefined,
    includeActiveNote: boolean,
  ): PersistedChatState {
    if (!stored || !Array.isArray(stored.conversations) || stored.conversations.length === 0) {
      return createInitialChatState(includeActiveNote);
    }
    const conversations = stored.conversations
      .filter((item) => item && typeof item.id === "string" && Array.isArray(item.messages))
      .map((item) => ({
        ...item,
        includeActiveNote:
          typeof item.includeActiveNote === "boolean" ? item.includeActiveNote : includeActiveNote,
        messages: item.messages
          .filter(
            (message, index, messages) =>
              messages.findIndex((candidate) => candidate.id === message.id) === index,
          )
          .map((message) => ({
            ...message,
            status: message.status === "streaming" ? "cancelled" : message.status ?? "complete",
          })),
      }));
    if (conversations.length === 0) return createInitialChatState(includeActiveNote);
    return {
      currentConversationId: conversations.some(
        (item) => item.id === stored.currentConversationId,
      )
        ? stored.currentConversationId
        : conversations[0].id,
      conversations,
    };
  }

  private trim(): void {
    const sorted = this.list().slice(0, Math.max(1, this.historyLimit));
    this.state.conversations = sorted;
    if (!sorted.some((item) => item.id === this.state.currentConversationId)) {
      this.state.currentConversationId = sorted[0].id;
    }
  }
}
