export type ChatRole = "user" | "assistant";
export type MessageStatus = "complete" | "streaming" | "error" | "cancelled";

export interface ChatAttachment {
  id: string;
  path: string;
  name: string;
  mimeType: string;
  kind: "image" | "file";
}

export interface ChatSource {
  path: string;
  label: string;
  kind: "file" | "folder" | "tag" | "active-note" | "open-tab";
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  status: MessageStatus;
  model?: string;
  errorDetails?: string;
  /** Accumulated model thought/reasoning for collapsible UI. */
  thoughtText?: string;
  attachments?: ChatAttachment[];
  sources?: ChatSource[];
  /** User message text that produced this assistant turn (for retry). */
  retryUserText?: string;
  retryAttachments?: ChatAttachment[];
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  includeActiveNote: boolean;
  /** Vault paths of open-tab notes included as context (max 3). */
  openTabPaths?: string[];
  /** True when the last completed turn used ACP/image transport (resume may be unreliable). */
  lastTurnUsedAcp?: boolean;
  /** Pinned conversations stay at the top of history and resist auto-trim preference. */
  pinned?: boolean;
  messages: ChatMessage[];
}

export interface PersistedChatState {
  currentConversationId: string;
  conversations: ChatConversation[];
}

export interface CustomPrompt {
  id: string;
  name: string;
  prompt: string;
  /** Optional short description shown in / menu and settings. */
  description?: string;
  /** Workflow templates get a clearer label in the slash menu. */
  isWorkflow?: boolean;
}

export interface ContextSelection {
  filePaths: string[];
  folderPaths: string[];
  tags: string[];
}

export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function createConversation(includeActiveNote = true): ChatConversation {
  const now = Date.now();
  return {
    id: createId("chat"),
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    includeActiveNote,
    messages: [],
  };
}

export function createInitialChatState(includeActiveNote = true): PersistedChatState {
  const conversation = createConversation(includeActiveNote);
  return {
    currentConversationId: conversation.id,
    conversations: [conversation],
  };
}
