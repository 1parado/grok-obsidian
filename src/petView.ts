import {
  App,
  ItemView,
  MarkdownRenderer,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type { PetStage } from "./grokRunner";
import type { ChatAttachment, ChatMessage, CustomPrompt } from "./chatTypes";
import {
  rankAtSuggestions,
  rankTagSuggestions,
  type RankableSuggestion,
} from "./suggestionRank";

export const GROK_PET_VIEW_TYPE = "grok-build-pet-view";

type SuggestionKind = "file" | "folder" | "tag" | "prompt";
interface ContextSuggestion {
  kind: SuggestionKind;
  key: string;
  title: string;
  subtitle: string;
  path?: string;
  prompt?: string;
  mtime?: number;
}

export interface PetViewState {
  stage: PetStage;
  progress: number | null;
  message: string;
  messages: ChatMessage[];
  attachments: ChatAttachment[];
  includeActiveNote: boolean;
  running: boolean;
  model: string;
}

const STAGE_LABEL: Record<PetStage, string> = {
  idle: "就绪",
  starting: "连接中",
  thinking: "思考中",
  writing: "回复中",
  done: "就绪",
  error: "出错",
  cancelled: "已停止",
};

export interface OpenTabChip {
  path: string;
  label: string;
  selected: boolean;
}

export class GrokPetView extends ItemView {
  private state: PetViewState = {
    stage: "idle",
    progress: null,
    message: "",
    messages: [],
    attachments: [],
    includeActiveNote: true,
    running: false,
    model: "CLI 默认模型",
  };

  private avatarEl!: HTMLImageElement;
  private stageEl!: HTMLElement;
  private modelEl!: HTMLElement;
  private chatEl!: HTMLElement;
  private contextRailEl!: HTMLElement;
  private turnSummaryEl!: HTMLElement;
  private mentionMenuEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private fileInputEl!: HTMLInputElement;
  private attachBtn!: HTMLButtonElement;
  private actionBtn!: HTMLButtonElement;
  private newChatBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private activeNoteBtn!: HTMLButtonElement;
  private dropTargetEl!: HTMLElement;

  private mentionResults: ContextSuggestion[] = [];
  private mentionIndex = 0;
  private mentionStart = -1;
  private mentionTrigger = "@";
  private mentionPreview = "";
  private mentionPreviewRequest = 0;
  private lastInsertedContextEnd = -1;
  private customPrompts: CustomPrompt[] = [];
  private activeNotePath: string | null = null;
  private activeNoteChipText = "当前笔记";
  private turnSummaryLine = "本轮无额外上下文";
  private turnSummaryTruncated = false;
  private openTabs: OpenTabChip[] = [];
  /** Cached vault index for @ suggestions (invalidated on vault events). */
  private atIndex: RankableSuggestion[] | null = null;
  private tagIndex: string[] | null = null;
  /** DOM handles for incremental streaming updates (avoid full chat re-render). */
  private messageNodeMap = new Map<
    string,
    { row: HTMLElement; textEl: HTMLElement; status: ChatMessage["status"] }
  >();

  private onCancel: (() => void) | null = null;
  private onSendMessage: ((message: string, attachments: ChatAttachment[]) => void) | null = null;
  private onNewChat: (() => void) | null = null;
  private onOpenHistory: (() => void) | null = null;
  private onPasteImages: ((files: File[]) => void) | null = null;
  private onDropFiles: ((files: File[]) => void) | null = null;
  private onDropContext: ((paths: string[]) => void) | null = null;
  private onRemoveAttachment: ((id: string) => void) | null = null;
  private onToggleActiveNote: ((value: boolean) => void) | null = null;
  private onCopyMessage: ((message: ChatMessage) => void) | null = null;
  private onEditMessage: ((message: ChatMessage) => void) | null = null;
  private onRegenerateMessage: ((message: ChatMessage) => void) | null = null;
  private onRetryMessage: ((message: ChatMessage) => void) | null = null;
  private onApplyMessage: ((message: ChatMessage) => void) | null = null;
  private onOpenSource: ((path: string) => void) | null = null;
  private onDraftContextChange: (() => void) | null = null;
  private onToggleOpenTab: ((path: string, selected: boolean) => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly iconSrc: string,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GROK_PET_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Grok Obsidian";
  }

  getIcon(): string {
    return "message-circle";
  }

  setHandlers(handlers: {
    onCancel: () => void;
    onSendMessage?: (message: string, attachments: ChatAttachment[]) => void;
    onNewChat?: () => void;
    onOpenHistory?: () => void;
    onPasteImages?: (files: File[]) => void;
    onDropFiles?: (files: File[]) => void;
    onDropContext?: (paths: string[]) => void;
    onRemoveAttachment?: (id: string) => void;
    onToggleActiveNote?: (value: boolean) => void;
    onCopyMessage?: (message: ChatMessage) => void;
    onEditMessage?: (message: ChatMessage) => void;
    onRegenerateMessage?: (message: ChatMessage) => void;
    onRetryMessage?: (message: ChatMessage) => void;
    onApplyMessage?: (message: ChatMessage) => void;
    onOpenSource?: (path: string) => void;
    onDraftContextChange?: () => void;
    onToggleOpenTab?: (path: string, selected: boolean) => void;
  }): void {
    this.onCancel = handlers.onCancel;
    this.onSendMessage = handlers.onSendMessage ?? null;
    this.onNewChat = handlers.onNewChat ?? null;
    this.onOpenHistory = handlers.onOpenHistory ?? null;
    this.onPasteImages = handlers.onPasteImages ?? null;
    this.onDropFiles = handlers.onDropFiles ?? null;
    this.onDropContext = handlers.onDropContext ?? null;
    this.onRemoveAttachment = handlers.onRemoveAttachment ?? null;
    this.onToggleActiveNote = handlers.onToggleActiveNote ?? null;
    this.onCopyMessage = handlers.onCopyMessage ?? null;
    this.onEditMessage = handlers.onEditMessage ?? null;
    this.onRegenerateMessage = handlers.onRegenerateMessage ?? null;
    this.onRetryMessage = handlers.onRetryMessage ?? null;
    this.onApplyMessage = handlers.onApplyMessage ?? null;
    this.onOpenSource = handlers.onOpenSource ?? null;
    this.onDraftContextChange = handlers.onDraftContextChange ?? null;
    this.onToggleOpenTab = handlers.onToggleOpenTab ?? null;
  }

  setOpenTabs(tabs: OpenTabChip[]): void {
    this.openTabs = tabs;
    if (this.contextRailEl) this.renderContextRail();
  }

  setActiveNotePath(path: string | null): void {
    this.activeNotePath = path;
  }

  setActiveNoteChipLabel(label: string): void {
    this.activeNoteChipText = label || "当前笔记";
    if (this.activeNoteBtn) this.renderContextRail();
  }

  setTurnContextSummary(line: string, truncated: boolean): void {
    this.turnSummaryLine = line;
    this.turnSummaryTruncated = truncated;
    if (this.turnSummaryEl) {
      this.turnSummaryEl.setText(line);
      this.turnSummaryEl.classList.toggle("is-truncated", truncated);
      this.turnSummaryEl.setAttr("title", truncated ? "上下文达到上限，部分内容会被截断" : line);
    }
  }

  getComposerText(): string {
    return this.inputEl?.value ?? "";
  }

  setCustomPrompts(prompts: CustomPrompt[]): void {
    this.customPrompts = prompts;
  }

  setModel(model: string): void {
    this.state.model = model.trim() || "CLI 默认模型";
    if (!this.modelEl) return;
    this.modelEl.setText(`模型 · ${this.state.model}`);
    this.modelEl.setAttr("title", `当前模型：${this.state.model}`);
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("grok-pet-view");

    const header = root.createDiv({ cls: "grok-pet-header" });
    const identity = header.createDiv({ cls: "grok-pet-identity" });
    this.avatarEl = identity.createEl("img", { cls: "grok-pet-avatar", attr: { src: this.iconSrc, alt: "" } });
    const identityText = identity.createDiv({ cls: "grok-pet-identity-text" });
    identityText.createDiv({ cls: "grok-pet-title", text: "Grok Obsidian" });
    this.stageEl = identityText.createDiv({ cls: "grok-pet-stage" });
    this.modelEl = identityText.createDiv({ cls: "grok-pet-model" });

    const headerActions = header.createDiv({ cls: "grok-pet-header-actions" });
    this.historyBtn = this.makeIconButton(headerActions, "history", "对话历史", () => this.onOpenHistory?.());
    this.newChatBtn = this.makeIconButton(headerActions, "plus", "新对话", () => this.onNewChat?.());

    this.chatEl = root.createDiv({ cls: "grok-pet-chat" });
    this.chatEl.setAttr("aria-live", "polite");

    this.dropTargetEl = root.createDiv({ cls: "grok-pet-drop-target", text: "松开以添加到上下文" });
    this.dropTargetEl.hidden = true;

    const composerShell = root.createDiv({ cls: "grok-pet-composer-shell" });
    this.mentionMenuEl = composerShell.createDiv({ cls: "grok-pet-mention-menu" });
    this.mentionMenuEl.hidden = true;
    this.turnSummaryEl = composerShell.createDiv({
      cls: "grok-pet-turn-summary",
      text: this.turnSummaryLine,
    });
    this.contextRailEl = composerShell.createDiv({ cls: "grok-pet-context-rail" });

    const composer = composerShell.createDiv({ cls: "grok-pet-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "grok-pet-input",
      attr: { rows: "1", placeholder: "消息", "aria-label": "消息" },
    });
    this.inputEl.addEventListener("input", () => {
      this.resizeInput();
      this.updateSuggestionMenu();
      this.renderContextRail();
      this.onDraftContextChange?.();
    });
    this.inputEl.addEventListener("blur", () => window.setTimeout(() => this.closeSuggestionMenu(), 120));
    this.inputEl.addEventListener("paste", (event) => this.handlePaste(event));
    this.inputEl.addEventListener("keydown", (event) => this.handleKeyDown(event));

    this.fileInputEl = composer.createEl("input", {
      cls: "grok-pet-file-input",
      attr: { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/bmp", multiple: "true" },
    });
    this.fileInputEl.addEventListener("change", () => {
      const files = Array.from(this.fileInputEl.files ?? []);
      if (files.length > 0) this.onPasteImages?.(files);
      this.fileInputEl.value = "";
    });
    this.attachBtn = this.makeIconButton(composer, "paperclip", "上传图片", () => this.fileInputEl.click());
    this.attachBtn.addClass("grok-pet-attach-button");

    this.actionBtn = composer.createEl("button", { cls: "grok-pet-action" });
    this.actionBtn.addEventListener("click", () => (this.state.running ? this.onCancel?.() : this.submitMessage()));

    root.addEventListener("dragover", (event) => this.handleDragOver(event));
    root.addEventListener("dragleave", (event) => this.handleDragLeave(event));
    root.addEventListener("drop", (event) => void this.handleDrop(event));

    this.registerEvent(
      this.app.vault.on("create", () => this.invalidateSuggestionIndex()),
    );
    this.registerEvent(
      this.app.vault.on("delete", () => this.invalidateSuggestionIndex()),
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.invalidateSuggestionIndex()),
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => this.invalidateSuggestionIndex()),
    );

    this.renderChat();
    this.renderContextRail();
    this.renderStatus();
    this.onDraftContextChange?.();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  setConversation(messages: ChatMessage[], includeActiveNote: boolean): void {
    this.state.messages = [...messages];
    this.state.includeActiveNote = includeActiveNote;
    this.renderChat();
    this.renderContextRail();
  }

  setPendingAttachments(attachments: ChatAttachment[]): void {
    this.state.attachments = attachments;
    this.renderContextRail();
    this.onDraftContextChange?.();
  }

  insertContextPaths(paths: string[]): void {
    const tokens = paths.map((path) => {
      const abstract = this.app.vault.getAbstractFileByPath(path);
      return abstract instanceof TFolder ? `@{${path}}` : `@[[${path}]]`;
    });
    if (tokens.length === 0) return;
    const separator = this.inputEl.value && !/\s$/.test(this.inputEl.value) ? " " : "";
    this.inputEl.value += `${separator}${tokens.join(" ")} `;
    this.resizeInput();
    this.renderContextRail();
    this.inputEl.focus();
  }

  update(partial: Partial<PetViewState>): void {
    if (partial.stage !== undefined) this.state.stage = partial.stage;
    if (partial.progress !== undefined) this.state.progress = partial.progress;
    if (partial.message !== undefined) this.state.message = partial.message;
    if (partial.running !== undefined) this.state.running = partial.running;
    if (partial.messages) this.state.messages = [...partial.messages];
    if (partial.attachments) this.state.attachments = partial.attachments;
    if (partial.includeActiveNote !== undefined) this.state.includeActiveNote = partial.includeActiveNote;
    this.renderStatus();
  }

  addChatMessage(message: ChatMessage): void {
    this.state.messages.push(message);
    if (this.state.messages.length > 240) {
      const dropped = this.state.messages.length - 240;
      this.state.messages = this.state.messages.slice(-240);
      // Dropped ids will be rebuilt on next full render if needed.
      if (dropped > 0) {
        this.renderChat();
        return;
      }
    }
    this.appendMessageNode(message);
    this.scrollChatToBottom();
  }

  updateChatMessage(id: string, patch: Partial<ChatMessage>): void {
    const message = this.state.messages.find((item) => item.id === id);
    if (!message) return;
    const prevStatus = message.status;
    Object.assign(message, patch);

    const node = this.messageNodeMap.get(id);
    // Fast path: streaming text only (no thought change) — update text node.
    if (
      node &&
      message.status === "streaming" &&
      prevStatus === "streaming" &&
      patch.text !== undefined &&
      patch.thoughtText === undefined &&
      patch.status !== "complete" &&
      patch.status !== "error" &&
      patch.status !== "cancelled"
    ) {
      node.textEl.setText(message.text || "…");
      this.scrollChatToBottom();
      return;
    }

    // Status transition, thought update, or missing node: rebuild this message.
    if (node && this.chatEl.contains(node.row)) {
      const next = this.buildMessageRow(message);
      node.row.replaceWith(next.row);
      this.messageNodeMap.set(id, next);
      this.scrollChatToBottom();
      return;
    }
    this.renderChat();
  }

  clearChat(): void {
    this.state.messages = [];
    this.renderChat();
    this.inputEl?.focus();
  }

  resetIdle(): void {
    this.state.stage = "idle";
    this.state.progress = null;
    this.state.message = "";
    this.state.running = false;
    this.renderStatus();
  }

  focusComposer(): void {
    this.inputEl?.focus();
  }

  setComposerText(text: string): void {
    this.inputEl.value = text;
    this.resizeInput();
    this.renderContextRail();
    this.onDraftContextChange?.();
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
  }

  private makeIconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "grok-pet-icon-button clickable-icon",
      attr: { "aria-label": label, title: label },
    });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
    return button;
  }

  private handlePaste(event: ClipboardEvent): void {
    const items = Array.from(event.clipboardData?.items ?? []).filter((item) => item.type.startsWith("image/"));
    const files = items.map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (files.length === 0) return;
    event.preventDefault();
    this.onPasteImages?.(files);
  }

  private handleDragOver(event: DragEvent): void {
    if (!event.dataTransfer) return;
    const hasFile = Array.from(event.dataTransfer.items).some((item) => item.kind === "file");
    const hasObsidianUri = Array.from(event.dataTransfer.types).some((type) => type === "text/uri-list" || type === "text/plain");
    if (!hasFile && !hasObsidianUri) return;
    event.preventDefault();
    this.dropTargetEl.hidden = false;
  }

  private handleDragLeave(event: DragEvent): void {
    const rect = this.contentEl.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      this.dropTargetEl.hidden = true;
    }
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    if (!event.dataTransfer) return;
    event.preventDefault();
    this.dropTargetEl.hidden = true;
    const imageFiles = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length > 0) this.onPasteImages?.(imageFiles);
    const otherFiles = Array.from(event.dataTransfer.files).filter((file) => !file.type.startsWith("image/"));
    if (otherFiles.length > 0) this.onDropFiles?.(otherFiles);
    const uriText = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    const paths = uriText
      .split(/\r?\n/)
      .map((line) => this.parseObsidianUri(line.trim()))
      .filter((path): path is string => Boolean(path));
    if (paths.length > 0) this.onDropContext?.(paths);
  }

  private parseObsidianUri(value: string): string | null {
    if (value.startsWith("obsidian://open")) {
      const file = value.match(/[?&]file=([^&]+)/)?.[1];
      return file ? decodeURIComponent(file) : null;
    }
    const abstract = this.app.vault.getAbstractFileByPath(value);
    return abstract instanceof TFile || abstract instanceof TFolder ? value : null;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.mentionMenuEl.hidden) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.moveSuggestion(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.moveSuggestion(-1);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && this.mentionResults.length > 0) {
        event.preventDefault();
        this.insertSuggestion(this.mentionIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSuggestionMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.submitMessage();
    }
  }

  private submitMessage(): void {
    if (this.state.running) return;
    const message = this.inputEl.value.trim();
    if (!message && this.state.attachments.length === 0) {
      this.inputEl.focus();
      return;
    }
    const attachments = [...this.state.attachments];
    this.inputEl.value = "";
    this.state.attachments = [];
    this.resizeInput();
    this.closeSuggestionMenu();
    this.renderContextRail();
    this.onSendMessage?.(message, attachments);
  }

  private resizeInput(): void {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 144)}px`;
  }

  private updateSuggestionMenu(): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const before = this.inputEl.value.slice(0, cursor);
    const match = before.match(/(?:^|\s)([@#/])([^\n]*)$/);
    if (!match) {
      this.closeSuggestionMenu();
      return;
    }
    const trigger = match[1];
    const matchStart = (match.index ?? 0) + (match[0].startsWith(" ") ? 1 : 0);
    if (this.lastInsertedContextEnd >= 0) {
      const afterInsertedToken = before.slice(this.lastInsertedContextEnd);
      if (!/[@#/]/.test(afterInsertedToken)) {
        this.closeSuggestionMenu();
        return;
      }
      this.lastInsertedContextEnd = -1;
    }
    const query = match[2].trimStart();
    if ((trigger === "@" && /[\[\]{}]/.test(query)) || (trigger === "#" && query.includes(" "))) {
      this.closeSuggestionMenu();
      return;
    }
    this.mentionTrigger = trigger;
    this.mentionStart = matchStart;
    const normalized = query.toLocaleLowerCase();
    this.mentionResults = this.getSuggestions(trigger, normalized);
    this.mentionIndex = 0;
    this.mentionPreview = "";
    this.renderSuggestionMenu();
    void this.loadSuggestionPreview();
  }

  private invalidateSuggestionIndex(): void {
    this.atIndex = null;
    this.tagIndex = null;
  }

  private ensureAtIndex(): RankableSuggestion[] {
    if (this.atIndex) return this.atIndex;
    const files: RankableSuggestion[] = this.app.vault.getFiles().map((file) => ({
      kind: "file" as const,
      key: file.path,
      title: file.name,
      subtitle: file.parent?.path || "Vault",
      path: file.path,
      mtime: file.stat?.mtime ?? 0,
    }));
    const folders: RankableSuggestion[] = this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => ({
        kind: "folder" as const,
        key: folder.path,
        title: folder.name,
        subtitle: folder.path,
        path: folder.path,
      }));
    this.atIndex = [...files, ...folders];
    return this.atIndex;
  }

  private ensureTagIndex(): string[] {
    if (this.tagIndex) return this.tagIndex;
    const tags = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      for (const tag of cache?.tags ?? []) tags.add(tag.tag.replace(/^#/, ""));
      const frontmatterTags = cache?.frontmatter?.tags;
      if (Array.isArray(frontmatterTags)) {
        frontmatterTags.forEach((tag) => tags.add(String(tag).replace(/^#/, "")));
      } else if (frontmatterTags) {
        tags.add(String(frontmatterTags).replace(/^#/, ""));
      }
    }
    this.tagIndex = Array.from(tags);
    return this.tagIndex;
  }

  private getSuggestions(trigger: string, query: string): ContextSuggestion[] {
    if (trigger === "/") {
      return rankAtSuggestions(
        this.customPrompts.map((item) => ({
          kind: "prompt" as const,
          key: item.id,
          title: item.name,
          subtitle: item.prompt,
          prompt: item.prompt,
        })),
        query,
        { limit: 40, recentBiasMaxQueryLen: 0 },
      );
    }
    if (trigger === "#") {
      return rankTagSuggestions(this.ensureTagIndex(), query, 80);
    }
    return rankAtSuggestions(this.ensureAtIndex(), query, {
      limit: 100,
      recentBiasMaxQueryLen: 1,
    });
  }

  private renderSuggestionMenu(): void {
    this.mentionMenuEl.empty();
    this.mentionMenuEl.hidden = false;
    if (this.mentionResults.length === 0) {
      this.mentionMenuEl.createDiv({ cls: "grok-pet-mention-empty", text: "没有匹配内容" });
      return;
    }
    this.mentionResults.forEach((suggestion, index) => {
      const item = this.mentionMenuEl.createEl("button", {
        cls: `grok-pet-mention-item${index === this.mentionIndex ? " is-selected" : ""}`,
        attr: { type: "button", title: suggestion.path ?? suggestion.subtitle },
      });
      const icon = item.createSpan({ cls: "grok-pet-mention-icon" });
      setIcon(icon, suggestion.kind === "file" ? "file-text" : suggestion.kind === "folder" ? "folder" : suggestion.kind === "tag" ? "hash" : "sparkles");
      const labels = item.createSpan({ cls: "grok-pet-mention-labels" });
      labels.createSpan({ cls: "grok-pet-mention-name", text: suggestion.title });
      labels.createSpan({ cls: "grok-pet-mention-path", text: suggestion.subtitle });
      if (index === this.mentionIndex && this.mentionPreview) labels.createSpan({ cls: "grok-pet-mention-preview", text: this.mentionPreview });
      item.addEventListener("mouseenter", () => {
        if (index === this.mentionIndex) return;
        this.mentionIndex = index;
        this.mentionPreview = "";
        this.renderSuggestionMenu();
        void this.loadSuggestionPreview();
      });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.insertSuggestion(index);
      });
    });
  }

  private moveSuggestion(delta: number): void {
    if (this.mentionResults.length === 0) return;
    this.mentionIndex = (this.mentionIndex + delta + this.mentionResults.length) % this.mentionResults.length;
    this.mentionPreview = "";
    this.renderSuggestionMenu();
    void this.loadSuggestionPreview();
    this.mentionMenuEl.querySelector<HTMLElement>(".grok-pet-mention-item.is-selected")?.scrollIntoView({ block: "nearest" });
  }

  private async loadSuggestionPreview(): Promise<void> {
    const suggestion = this.mentionResults[this.mentionIndex];
    const request = ++this.mentionPreviewRequest;
    if (!suggestion?.path || suggestion.kind !== "file") return;
    const file = this.app.vault.getAbstractFileByPath(suggestion.path);
    if (!(file instanceof TFile) || ["png", "jpg", "jpeg", "gif", "webp", "pdf"].includes(file.extension.toLowerCase())) return;
    try {
      const content = await this.app.vault.cachedRead(file);
      if (request !== this.mentionPreviewRequest) return;
      const plain = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").replace(/\s+/g, " ").trim();
      this.mentionPreview = plain.length > 240 ? `${plain.slice(0, 240)}…` : plain;
      this.renderSuggestionMenu();
    } catch {
      this.mentionPreview = "无法读取预览";
      this.renderSuggestionMenu();
    }
  }

  private insertSuggestion(index: number): void {
    const suggestion = this.mentionResults[index];
    if (!suggestion || this.mentionStart < 0) return;
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const token = suggestion.kind === "file"
      ? `@[[${suggestion.path}]] `
      : suggestion.kind === "folder"
        ? `@{${suggestion.path}} `
        : suggestion.kind === "tag"
          ? `#${suggestion.key} `
          : `${suggestion.prompt} `;
    this.inputEl.value = this.inputEl.value.slice(0, this.mentionStart) + token + this.inputEl.value.slice(cursor);
    const nextCursor = this.mentionStart + token.length;
    this.inputEl.setSelectionRange(nextCursor, nextCursor);
    this.lastInsertedContextEnd = nextCursor;
    this.closeSuggestionMenu();
    this.resizeInput();
    this.renderContextRail();
    this.inputEl.focus();
  }

  private closeSuggestionMenu(): void {
    if (!this.mentionMenuEl) return;
    this.mentionMenuEl.hidden = true;
    this.mentionMenuEl.empty();
    this.mentionResults = [];
    this.mentionIndex = 0;
    this.mentionStart = -1;
    this.mentionPreview = "";
    this.mentionPreviewRequest += 1;
    if (this.lastInsertedContextEnd < 0) this.lastInsertedContextEnd = -1;
  }

  private renderContextRail(): void {
    if (!this.contextRailEl) return;
    this.contextRailEl.empty();
    if (this.turnSummaryEl) {
      this.turnSummaryEl.setText(this.turnSummaryLine);
      this.turnSummaryEl.classList.toggle("is-truncated", this.turnSummaryTruncated);
    }
    const chipLabel = this.state.includeActiveNote
      ? this.activeNoteChipText
      : "当前笔记";
    const chipTitle = this.state.includeActiveNote
      ? this.activeNotePath
        ? `活动笔记：${this.activeNotePath}（点击关闭）`
        : "尚未记录活动笔记（先打开一篇 Markdown）"
      : "点击开启：把最近聚焦的 Markdown 笔记作为上下文";
    this.activeNoteBtn = this.contextRailEl.createEl("button", {
      cls: `grok-pet-context-chip${this.state.includeActiveNote ? " is-active" : ""}${this.state.includeActiveNote && !this.activeNotePath ? " is-empty" : ""}`,
      attr: { title: chipTitle },
    });
    setIcon(this.activeNoteBtn, "file-text");
    this.activeNoteBtn.createSpan({ text: chipLabel });
    this.activeNoteBtn.addEventListener("click", () =>
      this.onToggleActiveNote?.(!this.state.includeActiveNote),
    );
    // Open markdown tabs (select up to 3 as extra context).
    for (const tab of this.openTabs) {
      const chip = this.contextRailEl.createEl("button", {
        cls: `grok-pet-context-chip grok-pet-open-tab${tab.selected ? " is-active" : ""}`,
        attr: {
          type: "button",
          title: tab.selected
            ? `取消作为上下文：${tab.path}`
            : `加入上下文（最多 3 个）：${tab.path}`,
        },
      });
      setIcon(chip, "layers");
      chip.createSpan({ text: tab.label });
      chip.addEventListener("click", () => this.onToggleOpenTab?.(tab.path, !tab.selected));
    }
    for (const attachment of this.state.attachments) {
      const chip = this.contextRailEl.createDiv({ cls: "grok-pet-attachment-chip" });
      chip.createEl("img", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(attachment.path),
          alt: attachment.name,
          title: attachment.name,
        },
      });
      const remove = chip.createEl("button", {
        cls: "grok-pet-chip-remove",
        attr: { "aria-label": "移除图片", title: "移除图片" },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", () => this.onRemoveAttachment?.(attachment.id));
    }
    for (const context of this.getDraftContexts()) {
      const chip = this.contextRailEl.createDiv({ cls: "grok-pet-draft-context" });
      const icon = chip.createSpan();
      setIcon(
        icon,
        context.kind === "tag" ? "hash" : context.kind === "folder" ? "folder" : "file-text",
      );
      chip.createSpan({ text: context.label, attr: { title: context.value } });
      const remove = chip.createEl("button", {
        cls: "grok-pet-draft-remove",
        attr: { "aria-label": "移除上下文", title: "移除上下文" },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        this.inputEl.value = this.inputEl.value.replace(context.token, "").replace(/ {2,}/g, " ");
        this.renderContextRail();
        this.onDraftContextChange?.();
        this.inputEl.focus();
      });
    }
  }

  private getDraftContexts(): Array<{
    token: string;
    value: string;
    label: string;
    kind: "file" | "folder" | "tag";
  }> {
    const contexts: Array<{
      token: string;
      value: string;
      label: string;
      kind: "file" | "folder" | "tag";
    }> = [];
    const pattern = /@\[\[([^\]]+)\]\]|@\{([^}]+)\}|#([\p{L}\p{N}_/-]+)/gu;
    for (const match of this.inputEl?.value.matchAll(pattern) ?? []) {
      const file = match[1];
      const folder = match[2];
      const tag = match[3];
      const value = file ?? folder ?? tag;
      contexts.push({
        token: match[0],
        value,
        label: tag ? `#${tag}` : (value.split("/").pop() ?? value).replace(/\.[^.]+$/, ""),
        kind: tag ? "tag" : folder ? "folder" : "file",
      });
    }
    return contexts.filter(
      (item, index, array) => array.findIndex((other) => other.token === item.token) === index,
    );
  }

  private scrollChatToBottom(): void {
    if (!this.chatEl) return;
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }

  private appendMessageNode(message: ChatMessage): void {
    if (!this.chatEl) return;
    const node = this.buildMessageRow(message);
    this.chatEl.appendChild(node.row);
    this.messageNodeMap.set(message.id, node);
  }

  private buildMessageRow(message: ChatMessage): {
    row: HTMLElement;
    textEl: HTMLElement;
    status: ChatMessage["status"];
  } {
    const row = document.createElement("div");
    row.className = `grok-pet-message is-${message.role} is-${message.status}`;
    row.dataset.messageId = message.id;

    if (message.role === "assistant") {
      row.createEl("img", {
        cls: "grok-pet-message-avatar",
        attr: { src: this.iconSrc, alt: "" },
      });
    }

    const body = row.createDiv({ cls: "grok-pet-message-body" });

    if (message.role === "assistant" && message.status === "cancelled") {
      body.createDiv({
        cls: "grok-pet-status-banner is-cancelled",
        text: "已停止 · 以下为已生成的部分内容",
      });
    }
    if (message.role === "assistant" && message.status === "error") {
      body.createDiv({
        cls: "grok-pet-status-banner is-error",
        text: "出错了 · 可查看详情或用同一上下文重试",
      });
    }

    if (message.role === "assistant" && message.thoughtText?.trim()) {
      const thought = body.createEl("details", {
        cls: "grok-pet-thought",
        attr: message.status === "streaming" ? { open: "true" } : {},
      });
      const preview = message.thoughtText.trim().replace(/\s+/g, " ").slice(0, 80);
      thought.createEl("summary", {
        text:
          message.status === "streaming"
            ? `思考中… ${preview}${message.thoughtText.length > 80 ? "…" : ""}`
            : "思考过程",
      });
      thought.createEl("pre", { cls: "grok-pet-thought-body", text: message.thoughtText });
    } else if (message.role === "assistant" && message.status === "streaming" && !message.text) {
      body.createDiv({ cls: "grok-pet-thinking-placeholder", text: "思考中…" });
    }

    const textEl = body.createDiv({ cls: "grok-pet-message-text" });
    if (message.role === "assistant" && message.status !== "streaming") {
      if (message.text.trim()) {
        void MarkdownRenderer.render(this.app, message.text, textEl, "", this);
      } else if (message.status === "cancelled") {
        textEl.setText("（已停止，尚未生成内容）");
      }
    } else if (message.role === "user") {
      this.renderUserText(textEl, message.text);
    } else {
      textEl.setText(message.text || (message.thoughtText ? "" : "…"));
    }

    if (message.role === "assistant" && message.model) {
      body.createDiv({ cls: "grok-pet-message-model", text: message.model });
    }
    if (message.status === "error" && message.errorDetails) {
      const details = body.createEl("details", { cls: "grok-pet-error-details" });
      details.createEl("summary", { text: "查看错误详情" });
      details.createEl("pre", { text: message.errorDetails });
    }
    if (message.attachments?.length) {
      const images = body.createDiv({ cls: "grok-pet-message-attachments" });
      for (const attachment of message.attachments) {
        images.createEl("img", {
          attr: {
            src: this.app.vault.adapter.getResourcePath(attachment.path),
            alt: attachment.name,
            title: attachment.name,
          },
        });
      }
    }
    if (message.sources?.length) {
      const sources = body.createDiv({ cls: "grok-pet-sources" });
      for (const source of message.sources) {
        const button = sources.createEl("button", { attr: { title: source.path } });
        setIcon(
          button,
          source.kind === "tag"
            ? "hash"
            : source.kind === "folder"
              ? "folder"
              : source.kind === "open-tab"
                ? "layers"
                : "file-text",
        );
        button.createSpan({ text: source.label });
        button.addEventListener("click", () => this.onOpenSource?.(source.path));
      }
    }
    if (message.role === "assistant" && message.status !== "streaming") {
      const actions = body.createDiv({ cls: "grok-pet-message-actions" });
      const copy = this.makeIconButton(actions, "copy", "复制回答", () =>
        this.onCopyMessage?.(message),
      );
      copy.addClass("grok-pet-message-action");
      if (message.status === "error") {
        const retry = this.makeIconButton(actions, "rotate-cw", "用同一上下文重试", () =>
          this.onRetryMessage?.(message),
        );
        retry.addClass("grok-pet-message-action");
      } else {
        const regenerate = this.makeIconButton(actions, "refresh-cw", "重新生成", () =>
          this.onRegenerateMessage?.(message),
        );
        regenerate.addClass("grok-pet-message-action");
      }
      if (message.status === "complete" || message.status === "cancelled") {
        if (message.text.trim()) {
          const apply = this.makeIconButton(actions, "file-diff", "预览并应用文件更改", () =>
            this.onApplyMessage?.(message),
          );
          apply.addClass("grok-pet-message-action");
        }
      }
    } else if (message.role === "user" && message.status === "complete") {
      const actions = body.createDiv({ cls: "grok-pet-message-actions" });
      const edit = this.makeIconButton(actions, "pencil", "编辑并重新发送", () =>
        this.onEditMessage?.(message),
      );
      const copy = this.makeIconButton(actions, "copy", "复制消息", () =>
        this.onCopyMessage?.(message),
      );
      edit.addClass("grok-pet-message-action");
      copy.addClass("grok-pet-message-action");
    }

    return { row, textEl, status: message.status };
  }

  private renderChat(): void {
    if (!this.chatEl) return;
    this.chatEl.empty();
    this.messageNodeMap.clear();
    for (const message of this.state.messages) {
      this.appendMessageNode(message);
    }
    this.scrollChatToBottom();
  }

  private renderUserText(container: HTMLElement, text: string): void {
    const pattern = /@\[\[([^\]]+)\]\]|@\{([^}]+)\}|#([\p{L}\p{N}_/-]+)/gu;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) container.appendText(text.slice(cursor, index));
      const filePath = match[1];
      const folderPath = match[2];
      const tag = match[3];
      const raw = filePath ?? folderPath ?? tag;
      const label = tag
        ? `#${tag}`
        : `@${(raw.split("/").pop() ?? raw).replace(/\.[^.]+$/, "")}`;
      container.createSpan({
        cls: "grok-pet-file-pill",
        text: label,
        attr: { title: raw },
      });
      cursor = index + match[0].length;
    }
    if (cursor < text.length) container.appendText(text.slice(cursor));
  }

  private renderStatus(): void {
    if (!this.avatarEl) return;
    const { stage, running } = this.state;
    this.stageEl.setText(STAGE_LABEL[stage]);
    this.stageEl.setAttr("title", this.state.message || STAGE_LABEL[stage]);
    this.setModel(this.state.model);
    this.stageEl.className = `grok-pet-stage is-${stage}`;
    this.avatarEl.className = `grok-pet-avatar${running ? " is-active" : ""}`;
    this.newChatBtn.disabled = running;
    this.historyBtn.disabled = running;
    this.attachBtn.disabled = running;
    this.inputEl.disabled = running;
    if (running) this.closeSuggestionMenu();
    this.actionBtn.empty();
    setIcon(this.actionBtn, running ? "square" : "arrow-up");
    this.actionBtn.className = `grok-pet-action${running ? " is-stop" : ""}`;
    this.actionBtn.setAttr("aria-label", running ? "停止" : "发送");
    this.actionBtn.setAttr("title", running ? "停止" : "发送");
  }
}
