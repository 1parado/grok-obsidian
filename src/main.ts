import { Editor, MarkdownView, Menu, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import {
  attachmentToAcpImage,
  deleteVaultFiles,
  isPluginManagedScreenshot,
  saveDroppedFiles,
  saveImageFiles,
} from "./attachments";
import { ChatStore } from "./chatStore";
import { activeNoteChipLabel, resolveActiveNotePath } from "./activeNoteResolve";
import { parseContextSelection, tagMatches } from "./contextParse";
import {
  createId,
  type ChatAttachment,
  type ChatMessage,
  type ChatSource,
  type ContextSelection,
  type PersistedChatState,
} from "./chatTypes";
import { ApplyDiffModal } from "./diffModal";
import { GrokAcpRunner } from "./grokAcpRunner";
import {
  detectDefaultGrokModel,
  GrokRunner,
  resolveGrokBinary,
  testGrokCli,
  type GrokProgressEvent,
  type GrokRunResult,
} from "./grokRunner";
import { shouldInjectLocalHistory } from "./historyInjection";
import { ChatHistoryModal } from "./historyModal";
import { ContextInventoryModal } from "./contextInventoryModal";
import { ConfirmModal } from "./confirmModal";
import { GrokPetView, GROK_PET_VIEW_TYPE } from "./petView";
import {
  DEFAULT_SETTINGS,
  GrokBuildSettingTab,
  type GrokBuildSettings,
} from "./settings";
import {
  DEFAULT_CONTEXT_LIMITS,
  mergeContextLimits,
  estimateExpansionCap,
  summarizeTurnContext,
} from "./turnContextSummary";
import { buildContextInventory, type ContextInventoryItem } from "./contextInventory";
import { isUndoEntryValid, planUndoActions, type ApplyUndoEntry } from "./applyUndo";
import {
  attachmentVaultPaths,
  rewriteImageEmbeds,
} from "./imageEmbedRewrite";

const TEXT_CONTEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "jsonc", "yaml", "yml", "toml", "csv", "tsv",
  "js", "jsx", "ts", "tsx", "css", "scss", "html", "xml", "py", "java",
  "c", "h", "cpp", "hpp", "cs", "go", "rs", "sh", "ps1", "sql", "canvas",
]);

interface StoredPluginData extends Partial<GrokBuildSettings> {
  chatState?: PersistedChatState;
  /** Legacy field retained for migration; chat always uses plan. */
  permissionMode?: string;
}

function isDesktop(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isMobile = (window as any).app?.isMobile;
  return isMobile !== true && typeof process !== "undefined" && Boolean(process.versions?.node);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export default class GrokBuildPlugin extends Plugin {
  settings: GrokBuildSettings = DEFAULT_SETTINGS;
  private runner = new GrokRunner();
  private acpRunner = new GrokAcpRunner();
  private chatStore!: ChatStore;
  private pendingAttachments: ChatAttachment[] = [];
  private streamingMessageId: string | null = null;
  /** Prevent a second Enter/click from racing while context is being prepared. */
  private sendInFlight = false;
  private saveTimer: number | null = null;
  private detectedDefaultModel: string | null = null;
  private lastApplyUndo: ApplyUndoEntry | null = null;
  /** Last focused Markdown file path — used when Grok panel has focus. */
  private lastMarkdownPath: string | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.registerView(GROK_PET_VIEW_TYPE, (leaf) => {
      const view = new GrokPetView(leaf, this.getIconResourcePath());
      this.bindView(view);
      return view;
    });

    const ribbonIcon = this.addRibbonIcon("message-circle", "Open Grok Obsidian", () => {
      void this.activatePetView();
    });
    ribbonIcon.empty();
    ribbonIcon.addClass("grok-pet-ribbon");
    ribbonIcon.createEl("img", { attr: { src: this.getIconResourcePath(), alt: "" } });

    this.addCommand({
      id: "open-grok-pet",
      name: "Open Grok Obsidian",
      callback: () => void this.activatePetView().then(() => this.getPetView()?.focusComposer()),
    });
    this.addCommand({
      id: "grok-pet-new-chat",
      name: "Grok Obsidian: start a new conversation",
      callback: () => this.startNewChat(),
    });
    this.addCommand({
      id: "grok-cancel",
      name: "Grok: cancel running job",
      callback: () => this.cancelRun(),
    });
    this.addCommand({
      id: "grok-cleanup-screenshots",
      name: "Grok Obsidian: clean up orphan screenshots",
      callback: () =>
        void this.cleanupOrphanScreenshots().then((count) => {
          new Notice(count > 0 ? `已清理 ${count} 个孤立截图` : "没有可清理的孤立截图");
        }),
    });
    this.addCommand({
      id: "grok-send-editor-selection",
      name: "Grok Obsidian: send editor selection",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice("请先在编辑器中选择文本");
          return;
        }
        this.captureMarkdownFocus(view.file?.path);
        void this.activatePetView().then(() => {
          this.getPetView()?.setComposerText(selection);
        });
      },
    });
    this.addSettingTab(new GrokBuildSettingTab(this.app, this));
    void this.refreshDefaultModel();

    this.captureMarkdownFocus(this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (md?.file) this.captureMarkdownFocus(md.file.path);
        this.refreshContextUi();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.captureMarkdownFocus(file.path);
          this.refreshContextUi();
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        const selection = editor.getSelection().trim();
        if (!selection) return;
        menu.addItem((item) =>
          item
            .setTitle("发送选区到 Grok Obsidian")
            .setIcon("message-circle")
            .onClick(() => {
              this.captureMarkdownFocus(view.file?.path);
              void this.activatePetView().then(() => {
                this.getPetView()?.setComposerText(selection);
              });
            }),
        );
      }),
    );

    if (!isDesktop()) new Notice("Grok Obsidian 仅支持桌面端（需要本机 Grok CLI）");
  }

  onunload(): void {
    this.runner.cancel();
    this.acpRunner.cancel();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    void this.persistData();
    this.app.workspace.detachLeavesOfType(GROK_PET_VIEW_TYPE);
  }

  private async loadPluginData(): Promise<void> {
    const stored = (await this.loadData()) as StoredPluginData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
    // Drop legacy fields from live settings object if present.
    const legacy = this.settings as Partial<GrokBuildSettings> & {
      permissionMode?: string;
      model?: string;
    };
    delete legacy.permissionMode;
    delete legacy.model;
    if (!Array.isArray(this.settings.customPrompts)) {
      this.settings.customPrompts = DEFAULT_SETTINGS.customPrompts;
    }
    if (typeof this.settings.deleteAttachmentsOnCleanup !== "boolean") {
      this.settings.deleteAttachmentsOnCleanup = DEFAULT_SETTINGS.deleteAttachmentsOnCleanup;
    }
    if (
      typeof this.settings.idleTimeoutMs !== "number" ||
      !Number.isFinite(this.settings.idleTimeoutMs) ||
      this.settings.idleTimeoutMs < 5_000
    ) {
      this.settings.idleTimeoutMs = DEFAULT_SETTINGS.idleTimeoutMs;
    }
    this.settings.contextLimits = mergeContextLimits(this.settings.contextLimits);
    this.chatStore = new ChatStore(
      stored?.chatState,
      this.settings.historyLimit,
      this.settings.includeActiveNoteByDefault,
    );
  }

  async saveSettings(): Promise<void> {
    await this.persistData();
    this.getPetView()?.setCustomPrompts(this.settings.customPrompts);
    this.getPetView()?.setModel(this.displayModel);
  }

  applyHistoryLimit(limit: number): void {
    this.chatStore.setHistoryLimit(limit);
    const current = this.chatStore.current;
    this.getPetView()?.setConversation(current.messages, current.includeActiveNote);
    this.schedulePersist();
  }

  private async persistData(): Promise<void> {
    await this.saveData({ ...this.settings, chatState: this.chatStore.serialize() });
  }

  private get displayModel(): string {
    return this.detectedDefaultModel || "CLI 默认模型";
  }

  private get contextLimits(): typeof DEFAULT_CONTEXT_LIMITS {
    return mergeContextLimits(this.settings.contextLimits);
  }

  async refreshDefaultModelPublic(): Promise<void> {
    await this.refreshDefaultModel();
    this.refreshContextUi();
  }

  async testGrokCliPublic(): Promise<void> {
    const notice = new Notice("正在测试 grok CLI…", 0);
    const result = await testGrokCli(this.settings);
    notice.hide();
    new Notice(result.message, result.ok ? 5000 : 9000);
    await this.refreshDefaultModelPublic();
  }

  openPluginSettings(): void {
    // Obsidian exposes the settings modal on app.setting at runtime, but it is not in public typings.
    const setting = (this.app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }).setting;
    if (setting?.open) {
      setting.open();
      setting.openTabById?.(this.manifest.id);
      return;
    }
    new Notice("请打开 Obsidian 设置 → 社区插件 → Grok Obsidian");
  }

  private async refreshDefaultModel(): Promise<void> {
    const resolution = resolveGrokBinary(this.settings);
    if (!resolution.found) {
      this.detectedDefaultModel = null;
      this.getPetView()?.setModel("未检测到 grok · 请安装并登录 CLI");
      this.getPetView()?.setCliStatus(false, "未检测到 grok。请安装 CLI、执行 grok login，或在设置中填写可执行文件路径。");
      return;
    }
    // Always follow Grok Build / CLI default model (no plugin override).
    this.detectedDefaultModel = await detectDefaultGrokModel(this.settings);
    if (!this.detectedDefaultModel) {
      this.getPetView()?.setModel("已找到 CLI · 未能读取默认模型（可尝试 grok login）");
      this.getPetView()?.setCliStatus(true, null);
      return;
    }
    this.getPetView()?.setModel(this.displayModel);
    this.getPetView()?.setCliStatus(true, null);
  }

  private schedulePersist(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.persistData();
    }, 350);
  }

  private captureMarkdownFocus(path: string | null | undefined): void {
    if (path && path.endsWith(".md")) this.lastMarkdownPath = path;
  }

  private resolvedActiveNotePath(): string | null {
    const currentMarkdownPath =
      this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
    return resolveActiveNotePath({
      includeActiveNote: this.chatStore.current.includeActiveNote,
      currentMarkdownPath,
      lastMarkdownPath: this.lastMarkdownPath,
    });
  }

  private refreshContextUi(): void {
    const view = this.getPetView();
    if (!view) return;
    const activePath = this.resolvedActiveNotePath();
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selectionText =
      this.chatStore.current.includeActiveNote && activeView?.file?.path === activePath
        ? activeView.editor.getSelection().trim()
        : "";
    view.setActiveNotePath(activePath);
    view.setActiveNoteChipLabel(
      this.chatStore.current.includeActiveNote
        ? activeNoteChipLabel(activePath)
        : "当前笔记",
    );
    view.setSelectionChars(selectionText.length || null);
    const openPaths = this.getOpenMarkdownPaths();
    const selected = this.chatStore.current.openTabPaths ?? [];
    // Drop selections that are no longer open.
    const stillOpen = selected.filter((path) => openPaths.includes(path));
    if (stillOpen.length !== selected.length) {
      this.chatStore.setOpenTabPaths(stillOpen);
    }
    view.setOpenTabs(
      openPaths.map((path) => ({
        path,
        label: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
        selected: stillOpen.includes(path),
      })),
    );
    const draft = view.getComposerText();
    const summary = this.estimateDraftContext(draft, this.pendingAttachments.length, selectionText.length);
    view.setTurnContextSummary(summary.line, summary.truncated);
    const selection = parseContextSelection(draft, {
      files: this.contextLimits.maxFilesInMessage,
      folders: this.contextLimits.maxFoldersInMessage,
      tags: this.contextLimits.maxTagsInMessage,
    });
    const expanded = this.expandContextFiles(selection);
    view.setContextInventory(
      buildContextInventory({
        includeActiveNote: this.chatStore.current.includeActiveNote,
        activeNotePath: activePath,
        openTabPaths: stillOpen,
        draftMessage: draft,
        attachmentCount: this.pendingAttachments.length,
        expandedPaths: expanded.paths,
        expansionCapped: expanded.expansionCapped,
        selectionChars: selectionText.length,
        limits: this.contextLimits,
      }),
    );
  }

  private toggleOpenTab(path: string, selected: boolean): void {
    const current = new Set(this.chatStore.current.openTabPaths ?? []);
    if (selected) {
      if (current.size >= 3 && !current.has(path)) {
        new Notice("最多选择 3 个打开中的标签作为上下文");
        this.refreshContextUi();
        return;
      }
      current.add(path);
    } else {
      current.delete(path);
    }
    this.chatStore.setOpenTabPaths(Array.from(current));
    this.refreshContextUi();
    this.schedulePersist();
  }

  private bindView(view: GrokPetView): void {
    view.setCustomPrompts(this.settings.customPrompts);
    view.setModel(this.displayModel);
    view.setHandlers({
      onCancel: () => this.cancelRun(),
      onSendMessage: (message, attachments) => void this.sendChatMessage(message, attachments),
      onNewChat: () => this.startNewChat(),
      onOpenHistory: () => this.openHistory(),
      onPasteImages: (files) => void this.addImages(files),
      onDropFiles: (files) => void this.addDroppedFiles(files),
      onDropContext: (paths) => view.insertContextPaths(paths),
      onRemoveAttachment: (id) => void this.removePendingAttachment(id),
      onToggleActiveNote: (value) => this.setIncludeActiveNote(value),
      onOpenContextInventory: () => this.openContextInventory(),
      onRefreshCli: () => this.refreshDefaultModelPublic(),
      onOpenSettings: () => this.openPluginSettings(),
      onTestCli: () => this.testGrokCliPublic(),
      onUndoLastApply: () => this.undoLastApply(),
      onCopyMessage: (message) => void this.copyMessage(message),
      onEditMessage: (message) => this.editMessage(message),
      onRegenerateMessage: (message) => void this.regenerateMessage(message),
      onRetryMessage: (message) => void this.retryMessage(message),
      onApplyMessage: (message) => this.previewApply(message),
      onWriteBackMessage: (action, text) => void this.writeBackResponse(action, text),
      onOpenSource: (path) => void this.openSource(path),
      onDraftContextChange: () => this.refreshContextUi(),
      onToggleOpenTab: (path, selected) => this.toggleOpenTab(path, selected),
    });
    view.setConversation(this.chatStore.current.messages, this.chatStore.current.includeActiveNote);
    view.setPendingAttachments(this.pendingAttachments);
    view.setPendingUndoAvailable(isUndoEntryValid(this.lastApplyUndo));
    const resolution = resolveGrokBinary(this.settings);
    view.setCliStatus(
      resolution.found,
      resolution.found
        ? null
        : "未检测到 grok。请安装 CLI、执行 grok login，或在设置中填写可执行文件路径。",
    );
    this.refreshContextUi();
  }

  async activatePetView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(GROK_PET_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: GROK_PET_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof GrokPetView) this.bindView(leaf.view);
  }

  private getPetView(): GrokPetView | null {
    const view = this.app.workspace.getLeavesOfType(GROK_PET_VIEW_TYPE)[0]?.view;
    return view instanceof GrokPetView ? view : null;
  }

  private getIconResourcePath(): string {
    return this.app.vault.adapter.getResourcePath(
      `${this.app.vault.configDir}/plugins/${this.manifest.id}/icon.png`,
    );
  }

  private getVaultPath(): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = this.app.vault.adapter as any;
    if (typeof adapter?.getBasePath === "function") return adapter.getBasePath();
    return typeof adapter?.basePath === "string" ? adapter.basePath : null;
  }

  private get isRunning(): boolean {
    return this.runner.isRunning || this.acpRunner.isRunning;
  }

  cancelRun(): void {
    if (!this.isRunning) {
      new Notice("没有正在运行的 Grok 任务");
      return;
    }
    this.runner.cancel();
    this.acpRunner.cancel();
    new Notice("正在停止…已生成内容将保留");
  }

  private applyProgress(event: GrokProgressEvent): void {
    this.getPetView()?.update({
      stage: event.stage,
      progress: event.progress,
      message: event.message,
      running: !["done", "error", "cancelled", "idle"].includes(event.stage),
    });
    if (!this.streamingMessageId) return;
    const patch: Partial<ChatMessage> = { status: "streaming" };
    if (event.partialText !== undefined) patch.text = event.partialText;
    if (event.partialThought !== undefined) patch.thoughtText = event.partialThought;
    if (event.partialText !== undefined || event.partialThought !== undefined) {
      this.chatStore.updateMessage(this.streamingMessageId, patch);
      this.getPetView()?.updateChatMessage(this.streamingMessageId, patch);
    }
  }

  /** Markdown files currently open in workspace leaves (deduped). */
  private getOpenMarkdownPaths(): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        const path = view.file.path;
        if (!seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
    });
    return paths;
  }

  private findMarkdownView(path: string | null | undefined): MarkdownView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file && (!path || activeView.file.path === path)) return activeView;

    let found: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && (!path || view.file.path === path)) {
        found = view;
      }
    });
    return found;
  }

  private getWriteBackTarget(): { view: MarkdownView | null; file: TFile | null } {
    const targetPath = this.resolvedActiveNotePath() ?? this.lastMarkdownPath;
    const view = this.findMarkdownView(targetPath) ?? this.findMarkdownView(null);
    if (view?.file) return { view, file: view.file };

    const fallbackPath = targetPath ?? this.app.workspace.getActiveFile()?.path ?? null;
    const abstract = fallbackPath ? this.app.vault.getAbstractFileByPath(fallbackPath) : null;
    return {
      view: null,
      file: abstract instanceof TFile && abstract.extension === "md" ? abstract : null,
    };
  }

  private getFilesForTag(tag: string): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      const inline = (cache?.tags ?? []).some((item) =>
        tagMatches(item.tag.replace(/^#/, ""), tag),
      );
      const frontmatter = cache?.frontmatter?.tags;
      const values = Array.isArray(frontmatter) ? frontmatter : frontmatter ? [frontmatter] : [];
      return (
        inline ||
        values.some((value) => tagMatches(String(value).replace(/^#/, ""), tag))
      );
    });
  }

  private expandContextFiles(selection: ContextSelection): {
    paths: string[];
    sources: ChatSource[];
    expansionCapped: boolean;
  } {
    const paths = new Set(selection.filePaths);
    const sources: ChatSource[] = selection.filePaths.map((path) => ({
      path,
      label: path.split("/").pop() ?? path,
      kind: "file",
    }));
    let expansionCapped = false;
    const folderHits: number[] = [];
    const tagHits: number[] = [];

    for (const folder of selection.folderPaths) {
      sources.push({ path: folder, label: folder.split("/").pop() ?? folder, kind: "folder" });
      const matches = this.app.vault
        .getFiles()
        .filter(
          (file) =>
            file.path.startsWith(`${folder}/`) &&
            TEXT_CONTEXT_EXTENSIONS.has(file.extension.toLowerCase()),
        );
      folderHits.push(matches.length);
      if (matches.length > this.contextLimits.maxFilesPerFolder) expansionCapped = true;
      matches.slice(0, this.contextLimits.maxFilesPerFolder).forEach((file) => paths.add(file.path));
    }
    for (const tag of selection.tags) {
      sources.push({ path: `#${tag}`, label: `#${tag}`, kind: "tag" });
      const matches = this.getFilesForTag(tag);
      tagHits.push(matches.length);
      if (matches.length > this.contextLimits.maxFilesPerTag) expansionCapped = true;
      matches.slice(0, this.contextLimits.maxFilesPerTag).forEach((file) => paths.add(file.path));
    }

    const all = Array.from(paths);
    if (all.length > this.contextLimits.maxExpandedPaths) expansionCapped = true;
    const estimate = estimateExpansionCap(selection, folderHits, tagHits, this.contextLimits);
    expansionCapped = expansionCapped || estimate.expansionCapped;

    return {
      paths: all.slice(0, this.contextLimits.maxExpandedPaths),
      sources,
      expansionCapped,
    };
  }

  private async buildReferencedFileContext(
    paths: string[],
  ): Promise<{ text: string; contentTruncated: boolean }> {
    const blocks: string[] = [];
    let total = 0;
    let contentTruncated = false;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        blocks.push(
          `<referenced_file_error><path>${escapeXml(path)}</path><error>File not found</error></referenced_file_error>`,
        );
        continue;
      }
      if (!TEXT_CONTEXT_EXTENSIONS.has(file.extension.toLowerCase())) continue;
      try {
        const content = await this.app.vault.cachedRead(file);
        const allowed = Math.min(
          this.contextLimits.maxCharsPerFile,
          Math.max(0, this.contextLimits.maxCharsTotal - total),
        );
        const included = content.slice(0, allowed);
        total += included.length;
        if (included.length < content.length) contentTruncated = true;
        blocks.push(
          [
            "<referenced_file>",
            `<title>${escapeXml(file.basename)}</title>`,
            `<path>${escapeXml(file.path)}</path>`,
            "<content>",
            included + (included.length < content.length ? "\n[Content truncated]" : ""),
            "</content>",
            "</referenced_file>",
          ].join("\n"),
        );
      } catch (error) {
        blocks.push(
          `<referenced_file_error><path>${escapeXml(path)}</path><error>${escapeXml(String(error))}</error></referenced_file_error>`,
        );
      }
    }
    return { text: blocks.join("\n\n"), contentTruncated };
  }

  private recentConversationText(): string {
    const messages = this.chatStore.current.messages
      .filter((message) => message.status === "complete")
      .slice(-11);
    if (messages.at(-1)?.role === "user") messages.pop();
    return messages
      .slice(-10)
      .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
      .join("\n\n");
  }

  private async buildChatPrompt(
    message: string,
    attachments: ChatAttachment[],
    includeHistory: boolean,
  ): Promise<{ prompt: string; sources: ChatSource[] }> {
    const selection = parseContextSelection(message, {
      files: this.contextLimits.maxFilesInMessage,
      folders: this.contextLimits.maxFoldersInMessage,
      tags: this.contextLimits.maxTagsInMessage,
    });
    const expanded = this.expandContextFiles(selection);
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeNotePath = resolveActiveNotePath({
      includeActiveNote: this.chatStore.current.includeActiveNote,
      currentMarkdownPath: activeView?.file?.path ?? null,
      lastMarkdownPath: this.lastMarkdownPath,
    });
    if (activeNotePath) {
      expanded.paths.unshift(activeNotePath);
      const label = activeNotePath.split("/").pop()?.replace(/\.md$/i, "") ?? activeNotePath;
      expanded.sources.unshift({
        path: activeNotePath,
        label,
        kind: "active-note",
      });
    }
    for (const tabPath of this.chatStore.current.openTabPaths ?? []) {
      if (!tabPath || tabPath === activeNotePath) continue;
      expanded.paths.unshift(tabPath);
      expanded.sources.unshift({
        path: tabPath,
        label: tabPath.split("/").pop()?.replace(/\.md$/i, "") ?? tabPath,
        kind: "open-tab",
      });
    }
    const uniquePaths = Array.from(new Set(expanded.paths));
    const referenced = await this.buildReferencedFileContext(uniquePaths);
    const selectionText =
      this.chatStore.current.includeActiveNote && activeView?.file?.path === activeNotePath
        ? activeView.editor.getSelection().trim()
        : "";
    const history = includeHistory ? this.recentConversationText() : "";
    const imagePaths = attachmentVaultPaths(attachments);

    const prompt = [
      "You are Grok Obsidian, a conversational assistant inside an Obsidian vault.",
      "Respond directly with clear Markdown.",
      "Do not modify files during chat. When the user asks for edits, return proposals the plugin can preview as a multi-file diff:",
      "1) Full file (create or replace): put the vault path in the fence info, e.g.",
      "```md:Notes/example.md",
      "full file contents",
      "```",
      "or a heading `### Notes/example.md` immediately before a fenced block.",
      "2) Partial edit of an existing file: path heading, then one or more unique SEARCH/REPLACE blocks:",
      "### Notes/example.md",
      "<<<<<<< SEARCH",
      "exact old text (must match once)",
      "=======",
      "new text",
      ">>>>>>> REPLACE",
      "You may propose multiple files in one reply. Prefer partial SEARCH/REPLACE for small edits; use full-file blocks for new notes or large rewrites.",
      "Treat explicit file, folder, tag, active-note, and image context as user-provided source material.",
      "Do not claim a source supports a statement unless that source actually contains it.",
      "",
      ...(history ? ["--- RECENT CONVERSATION ---", history, "--- END CONVERSATION ---", ""] : []),
      ...(selectionText ? ["--- ACTIVE SELECTION ---", selectionText, "--- END SELECTION ---", ""] : []),
      ...(referenced.text
        ? ["--- VAULT CONTEXT ---", referenced.text, "--- END VAULT CONTEXT ---", ""]
        : []),
      ...(imagePaths.length
        ? [
            "--- ATTACHED IMAGES ---",
            "These image files are ALREADY saved in the vault at the vault-relative paths below.",
            "The binary is also sent as ACP image blocks for vision only — that is not a separate file path.",
            "When embedding an image into a note, you MUST use the exact path listed here.",
            "Correct Obsidian syntax: ![[exact/vault/path.png]]",
            "Never invent filenames such as image-<uuid>.png, session asset ids, or temporary ACP names.",
            "Never claim the user must copy the image into the vault; it is already there.",
            "Attached vault paths:",
            ...imagePaths.map((path, index) => `${index + 1}. ${path}`),
            "--- END IMAGES ---",
            "",
          ]
        : []),
      "--- USER MESSAGE ---",
      message || "请分析附加的图片。",
      "--- END MESSAGE ---",
    ].join("\n");

    const dedupedSources = expanded.sources.filter(
      (source, index, array) => array.findIndex((item) => item.path === source.path) === index,
    );
    return { prompt, sources: dedupedSources };
  }

  private async executePrompt(
    prompt: string,
    imageAttachments: ChatAttachment[] = [],
  ): Promise<GrokRunResult | null> {
    if (!isDesktop()) return null;
    if (this.isRunning) {
      new Notice("已有任务在运行，请先停止或等待完成");
      return null;
    }
    const cwd = this.getVaultPath();
    if (!cwd) {
      new Notice("无法获取 Vault 绝对路径");
      return null;
    }
    await this.activatePetView();
    this.getPetView()?.update({ running: true, stage: "starting", progress: 3 });

    const images = (
      await Promise.all(
        imageAttachments.map((attachment) => attachmentToAcpImage(this.app, attachment)),
      )
    ).filter((image): image is NonNullable<typeof image> => image !== null);

    const result =
      images.length > 0
        ? await this.acpRunner.run({
            prompt,
            images,
            cwd,
            settings: this.settings,
            resumeSessionId: this.chatStore.current.sessionId,
            onProgress: (event) => this.applyProgress(event),
          })
        : await this.runner.run({
            prompt,
            cwd,
            settings: this.settings,
            resumeSessionId: this.chatStore.current.sessionId,
            onProgress: (event) => this.applyProgress(event),
          });

    this.getPetView()?.update({
      running: false,
      stage: result.ok ? "done" : result.error === "cancelled" ? "cancelled" : "error",
      progress: 100,
    });
    return result;
  }

  private async sendChatMessage(
    message: string,
    attachments: ChatAttachment[],
    addUserMessage = true,
  ): Promise<void> {
    if (this.isRunning || this.sendInFlight) return;
    this.sendInFlight = true;
    let assistantId: string | null = null;
    try {
      if (addUserMessage) {
        this.pendingAttachments = [];
        this.getPetView()?.setPendingAttachments([]);
      }
      if (addUserMessage) {
        const userMessage: ChatMessage = {
          id: createId("message"),
          role: "user",
          text: message,
          createdAt: Date.now(),
          status: "complete",
          attachments,
        };
        this.chatStore.addMessage(userMessage);
        this.getPetView()?.addChatMessage(userMessage);
      }

      // Inject local history for images, missing session, or text-after-ACP.
      const includeHistory = shouldInjectLocalHistory({
        hasImageAttachments: attachments.length > 0,
        hasSessionId: Boolean(this.chatStore.current.sessionId),
        lastTurnUsedAcp: Boolean(this.chatStore.current.lastTurnUsedAcp),
      });
      const usedAcp = attachments.length > 0;
      const built = await this.buildChatPrompt(message, attachments, includeHistory);
      const assistant: ChatMessage = {
        id: createId("message"),
        role: "assistant",
        text: "",
        createdAt: Date.now(),
        status: "streaming",
        model: this.displayModel,
        sources: built.sources,
        retryUserText: message,
        retryAttachments: attachments,
      };
      this.chatStore.addMessage(assistant);
      assistantId = assistant.id;
      this.getPetView()?.addChatMessage(assistant);
      this.streamingMessageId = assistant.id;
      this.schedulePersist();

      if (!resolveGrokBinary(this.settings).found) {
        new Notice("未检测到 grok，请安装 CLI 或在高级设置中填写路径，并确认已登录");
      }

      const result = await this.executePrompt(built.prompt, attachments);
      // Remember ACP usage even on failure so a following text turn still injects history.
      this.chatStore.setLastTurnUsedAcp(usedAcp);
      const current = this.chatStore.current.messages.find((item) => item.id === assistant.id);
      const partial = current?.text ?? "";
      const thoughtText = current?.thoughtText;
      if (!result) {
        this.chatStore.updateMessage(assistant.id, {
          status: "error",
          text: partial || "无法启动 Grok。",
          errorDetails: resolveGrokBinary(this.settings).found
            ? "当前环境无法启动 Grok CLI。"
            : "未检测到 grok 可执行文件。请安装 Grok Build CLI、执行 grok login，或在高级设置中填写路径。",
          thoughtText,
        });
      } else if (result.ok) {
        const rawText = result.text || partial || "任务已完成，但没有返回文字。";
        const fixedText = this.rewriteAssistantImageEmbeds(rawText, attachments);
        this.chatStore.updateMessage(assistant.id, {
          status: "complete",
          text: fixedText,
          errorDetails: undefined,
          thoughtText,
        });
        if (result.sessionId) this.chatStore.setSessionId(result.sessionId);
      } else if (result.error === "cancelled") {
        // Keep partial answer; do not look like a hard error.
        this.chatStore.updateMessage(assistant.id, {
          status: "cancelled",
          text: partial.trim() ? partial : "（已停止，尚未生成内容）",
          errorDetails: undefined,
          thoughtText,
        });
      } else {
        this.chatStore.updateMessage(assistant.id, {
          status: "error",
          text: partial.trim() ? partial : `运行失败：${result.error ?? "未知错误"}`,
          errorDetails: result.error ?? "未知错误",
          thoughtText,
        });
      }
      this.streamingMessageId = null;
      this.getPetView()?.setConversation(
        this.chatStore.current.messages,
        this.chatStore.current.includeActiveNote,
      );
      await this.persistData();
    } catch (error) {
      const details = error instanceof Error ? error.stack || error.message : String(error);
      if (assistantId) {
        const partial =
          this.chatStore.current.messages.find((item) => item.id === assistantId)?.text ?? "";
        this.chatStore.updateMessage(assistantId, {
          status: "error",
          text: partial || "Grok 请求处理失败。",
          errorDetails: details,
        });
      }
      this.streamingMessageId = null;
      this.getPetView()?.update({ running: false, stage: "error", progress: 100, message: details });
      this.getPetView()?.setConversation(
        this.chatStore.current.messages,
        this.chatStore.current.includeActiveNote,
      );
      await this.persistData();
    } finally {
      this.sendInFlight = false;
    }
  }

  private async addImages(files: File[]): Promise<void> {
    try {
      const activePath = this.app.workspace.getActiveFile()?.path;
      const saved = await saveImageFiles(this.app, files, activePath);
      this.pendingAttachments = [...this.pendingAttachments, ...saved].slice(0, 4);
      this.getPetView()?.setPendingAttachments(this.pendingAttachments);
      if (saved.length === 0) new Notice("没有找到可用图片");
    } catch (error) {
      new Notice(`图片处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async addDroppedFiles(files: File[]): Promise<void> {
    try {
      const activePath = this.app.workspace.getActiveFile()?.path;
      const paths = await saveDroppedFiles(this.app, files, activePath);
      this.getPetView()?.insertContextPaths(paths);
      if (paths.length === 0) new Notice("没有可添加的文件");
    } catch (error) {
      new Notice(`文件处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async removePendingAttachment(id: string): Promise<void> {
    const removed = this.pendingAttachments.find((item) => item.id === id);
    this.pendingAttachments = this.pendingAttachments.filter((item) => item.id !== id);
    this.getPetView()?.setPendingAttachments(this.pendingAttachments);
    if (removed && this.settings.deleteAttachmentsOnCleanup && isPluginManagedScreenshot(removed.path)) {
      await deleteVaultFiles(this.app, [removed.path]);
    }
  }

  private setIncludeActiveNote(value: boolean): void {
    this.chatStore.setIncludeActiveNote(value);
    this.getPetView()?.setConversation(this.chatStore.current.messages, value);
    this.refreshContextUi();
    this.schedulePersist();
  }

  /** Used by the pet view to estimate turn context without re-reading file bodies. */
  estimateDraftContext(
    draftMessage: string,
    attachmentCount: number,
    selectionChars = 0,
  ): ReturnType<typeof summarizeTurnContext> {
    const selection = parseContextSelection(draftMessage, {
      files: this.contextLimits.maxFilesInMessage,
      folders: this.contextLimits.maxFoldersInMessage,
      tags: this.contextLimits.maxTagsInMessage,
    });
    const expanded = this.expandContextFiles(selection);
    const activeNotePath = this.resolvedActiveNotePath();
    let expandedPathCount = expanded.paths.length;
    if (activeNotePath && !expanded.paths.includes(activeNotePath)) {
      expandedPathCount += 1;
    }
    for (const tab of this.chatStore.current.openTabPaths ?? []) {
      if (tab !== activeNotePath && !expanded.paths.includes(tab)) expandedPathCount += 1;
    }
    const summary = summarizeTurnContext({
      includeActiveNote: this.chatStore.current.includeActiveNote,
      activeNotePath,
      draftMessage,
      attachmentCount,
      expandedPathCount,
      expansionCapped: expanded.expansionCapped,
      selectionChars,
      limits: this.contextLimits,
    });
    const tabCount = (this.chatStore.current.openTabPaths ?? []).length;
    if (tabCount > 0) {
      summary.line =
        summary.line === "本轮无额外上下文"
          ? `打开标签 ${tabCount}`
          : `${summary.line} · 标签 ${tabCount}`;
    }
    return summary;
  }

  private openHistory(): void {
    new ChatHistoryModal(
      this.app,
      this.chatStore.list(),
      (conversation) => {
        this.chatStore.select(conversation.id);
        this.pendingAttachments = [];
        this.getPetView()?.setConversation(conversation.messages, conversation.includeActiveNote);
        this.getPetView()?.setPendingAttachments([]);
        this.refreshContextUi();
        this.schedulePersist();
      },
      async (conversation) => {
        const removed = this.chatStore.takeDeleted(
          conversation.id,
          this.settings.includeActiveNoteByDefault,
        );
        if (!removed) return;
        if (this.settings.deleteAttachmentsOnCleanup) {
          const paths = this.chatStore
            .collectAttachmentPaths(removed)
            .filter((path) => isPluginManagedScreenshot(path));
          // Only delete paths no longer referenced by remaining chats.
          const stillUsed = this.chatStore.allReferencedAttachmentPaths();
          const orphans = paths.filter((path) => !stillUsed.has(path));
          if (orphans.length) await deleteVaultFiles(this.app, orphans);
        }
        const current = this.chatStore.current;
        this.pendingAttachments = [];
        this.getPetView()?.setConversation(current.messages, current.includeActiveNote);
        this.getPetView()?.setPendingAttachments([]);
        this.refreshContextUi();
        await this.persistData();
        new Notice("对话已删除");
      },
      (conversation, title) => {
        const ok = this.chatStore.rename(conversation.id, title);
        if (ok) this.schedulePersist();
        return ok;
      },
      async (conversation) => {
        const md = this.chatStore.exportMarkdown(conversation.id);
        if (!md) {
          new Notice("导出失败");
          return;
        }
        const safeTitle = (conversation.title || "对话")
          .replace(/[\\/:*?"<>|]/g, "-")
          .slice(0, 40);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const path = await this.app.fileManager.getAvailablePathForAttachment(
          `Grok Chat ${safeTitle} ${stamp}.md`,
        );
        await this.app.vault.create(path, md);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
        new Notice(`已导出：${path}`);
      },
    ).open();
  }

  startNewChat(): void {
    if (this.isRunning) {
      new Notice("请先停止或等待当前任务完成");
      return;
    }
    const conversation = this.chatStore.create(this.settings.includeActiveNoteByDefault);
    this.pendingAttachments = [];
    void this.activatePetView().then(() => {
      this.getPetView()?.setConversation(conversation.messages, conversation.includeActiveNote);
      this.getPetView()?.setPendingAttachments([]);
      this.getPetView()?.focusComposer();
    });
    this.schedulePersist();
  }

  private async copyMessage(message: ChatMessage): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.text);
      new Notice(message.role === "assistant" ? "回答已复制" : "消息已复制");
    } catch (error) {
      new Notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private editMessage(message: ChatMessage): void {
    if (this.isRunning || this.sendInFlight) {
      new Notice("请先停止或等待当前任务完成");
      return;
    }
    if (message.role !== "user") return;
    this.chatStore.truncateFrom(message.id);
    this.chatStore.setSessionId(undefined);
    this.pendingAttachments = [...(message.attachments ?? [])];
    const view = this.getPetView();
    view?.setConversation(this.chatStore.current.messages, this.chatStore.current.includeActiveNote);
    view?.setPendingAttachments(this.pendingAttachments);
    view?.setComposerText(message.text);
    this.schedulePersist();
  }

  private async regenerateMessage(message: ChatMessage): Promise<void> {
    const messages = this.chatStore.current.messages;
    const index = messages.findIndex((item) => item.id === message.id);
    let user: ChatMessage | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor].role === "user") {
        user = messages[cursor];
        break;
      }
    }
    if (!user) return;
    this.chatStore.removeMessage(message.id);
    this.chatStore.setSessionId(undefined);
    this.getPetView()?.setConversation(
      this.chatStore.current.messages,
      this.chatStore.current.includeActiveNote,
    );
    await this.sendChatMessage(user.text, user.attachments ?? [], false);
  }

  /** Retry a failed assistant turn with the same user text/attachments/context. */
  private async retryMessage(message: ChatMessage): Promise<void> {
    if (this.isRunning || this.sendInFlight) {
      new Notice("请先停止或等待当前任务完成");
      return;
    }
    const text = message.retryUserText;
    if (!text && !(message.retryAttachments?.length)) {
      // Fall back: find preceding user message
      await this.regenerateMessage(message);
      return;
    }
    this.chatStore.removeMessage(message.id);
    this.chatStore.setSessionId(undefined);
    this.getPetView()?.setConversation(
      this.chatStore.current.messages,
      this.chatStore.current.includeActiveNote,
    );
    await this.sendChatMessage(text ?? "", message.retryAttachments ?? [], false);
  }

  private previewApply(message: ChatMessage): void {
    const active = this.app.workspace.getActiveFile();
    const fallbackPath =
      active && !active.path.includes("..") ? active.path : undefined;
    // Fix invented image-* embeds using this turn's attachments (and any stored on the message).
    const responseText = this.rewriteAssistantImageEmbeds(
      message.text,
      message.retryAttachments ?? [],
    );
    new ApplyDiffModal(this.app, responseText, fallbackPath, (summary, undo) => {
      const notice = new Notice(summary, 6000);
      if (undo && isUndoEntryValid(undo)) {
        this.lastApplyUndo = undo;
        this.getPetView()?.setPendingUndoAvailable(true);
        const undoButton = notice.noticeEl.createEl("button", {
          cls: "grok-undo-button",
          text: "撤销",
          attr: { type: "button" },
        });
        undoButton.addEventListener("click", () => void this.undoApply(undo));
      }
    }, (action, text) => this.writeBackResponse(action, text)).open();
  }

  /**
   * Replace model-invented image embed targets (e.g. image-<uuid>.png) with real
   * vault attachment paths from the current turn. Also rewrites missing image
   * targets when the vault cannot resolve them.
   */
  private rewriteAssistantImageEmbeds(
    text: string,
    attachments: ChatAttachment[],
  ): string {
    const knownPaths = attachmentVaultPaths(attachments);
    if (!text || knownPaths.length === 0) return text;
    const { text: fixed, rewrites } = rewriteImageEmbeds(text, knownPaths, {
      pathExists: (vaultRelativePath) => this.vaultPathResolves(vaultRelativePath),
    });
    if (rewrites.length > 0) {
      console.debug(
        "[Grok Obsidian] rewrote image embeds:",
        rewrites.map((item) => `${item.from} → ${item.to}`).join("; "),
      );
    }
    return fixed;
  }

  /** True when Obsidian can resolve a wikilink/embed path to an existing file. */
  private vaultPathResolves(vaultRelativePath: string): boolean {
    const normalized = vaultRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized) return false;
    if (this.app.vault.getAbstractFileByPath(normalized) instanceof TFile) return true;
    try {
      const dest = this.app.metadataCache.getFirstLinkpathDest(normalized, "");
      return dest instanceof TFile;
    } catch {
      return false;
    }
  }

  private async undoApply(entry: ApplyUndoEntry): Promise<void> {
    if (!isUndoEntryValid(entry)) {
      this.lastApplyUndo = null;
      this.getPetView()?.setPendingUndoAvailable(false);
      new Notice("撤销已过期");
      return;
    }
    const actions = planUndoActions(entry);
    for (const action of actions) {
      const abstract = this.app.vault.getAbstractFileByPath(action.path);
      if (action.action === "delete") {
        if (abstract instanceof TFile) {
          await this.app.vault.delete(abstract);
        }
      } else if (abstract instanceof TFile) {
        await this.app.vault.modify(abstract, action.content);
      } else {
        await this.app.vault.create(action.path, action.content);
      }
    }
    if (this.lastApplyUndo?.id === entry.id) {
      this.lastApplyUndo = null;
      this.getPetView()?.setPendingUndoAvailable(false);
    }
    new Notice("已撤销最近一次应用");
  }

  private async undoLastApply(): Promise<void> {
    const entry = this.lastApplyUndo;
    if (!entry || !isUndoEntryValid(entry)) {
      this.lastApplyUndo = null;
      this.getPetView()?.setPendingUndoAvailable(false);
      new Notice("没有可撤销的最近应用");
      return;
    }
    await this.undoApply(entry);
  }

  private openContextInventory(): void {
    const activePath = this.resolvedActiveNotePath();
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selectionText =
      this.chatStore.current.includeActiveNote && activeView?.file?.path === activePath
        ? activeView.editor.getSelection().trim()
        : "";
    const draft = this.getPetView()?.getComposerText() ?? "";
    const selection = parseContextSelection(draft, {
      files: this.contextLimits.maxFilesInMessage,
      folders: this.contextLimits.maxFoldersInMessage,
      tags: this.contextLimits.maxTagsInMessage,
    });
    const expanded = this.expandContextFiles(selection);
    new ContextInventoryModal(
      this.app,
      buildContextInventory({
        includeActiveNote: this.chatStore.current.includeActiveNote,
        activeNotePath: activePath,
        openTabPaths: this.chatStore.current.openTabPaths ?? [],
        draftMessage: draft,
        attachmentCount: this.pendingAttachments.length,
        expandedPaths: expanded.paths,
        expansionCapped: expanded.expansionCapped,
        selectionChars: selectionText.length,
        limits: this.contextLimits,
      }),
      (path) => this.openSource(path),
      (item) => this.removeContextInventoryItem(item),
    ).open();
  }

  private removeContextInventoryItem(item: ContextInventoryItem): void {
    const view = this.getPetView();
    if (item.kind === "active-note") {
      this.setIncludeActiveNote(false);
      new Notice("已关闭当前笔记上下文");
      return;
    }
    if (item.kind === "open-tab" && item.path) {
      this.toggleOpenTab(item.path, false);
      new Notice("已移除打开标签上下文");
      return;
    }
    if (item.kind === "image") {
      this.pendingAttachments = [];
      view?.setPendingAttachments([]);
      this.refreshContextUi();
      new Notice("已移除待发送图片");
      return;
    }
    if (item.token && view) {
      const draft = view.getComposerText();
      const next = draft
        .replace(item.token, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+\n/g, "\n")
        .trimStart();
      view.setComposerText(next);
      this.refreshContextUi();
      new Notice("已移除此上下文");
    }
  }

  private async writeBackResponse(action: "insert" | "append" | "create", text: string): Promise<void> {
    const target = this.getWriteBackTarget();
    const activeFile = target.file ?? this.app.workspace.getActiveFile();
    if ((action === "insert" || action === "append") && activeFile) {
      const ok = await new ConfirmModal(
        this.app,
        action === "insert" ? "插入到当前笔记" : "追加到当前笔记",
        `将写入：${activeFile.path}\n\n请确认要写入这段回答。`,
        action === "insert" ? "确认插入" : "确认追加",
        "取消",
      ).wait();
      if (!ok) return;
    }
    if (action === "insert") {
      let editor = target.view?.editor ?? null;
      if (!editor && target.file) {
        await this.app.workspace.getLeaf("tab").openFile(target.file);
        editor = this.findMarkdownView(target.file.path)?.editor ?? null;
      }
      if (!editor) {
        new Notice("当前没有可写入的 Markdown 编辑器");
        return;
      }
      editor.replaceSelection(text);
      new Notice("已插入到当前笔记");
      return;
    }
    if (action === "append") {
      const editor = target.view?.editor ?? null;
      if (editor) {
        const prefix = editor.getValue().trimEnd().length > 0 ? "\n\n" : "";
        const lastLine = editor.lastLine();
        const end = { line: lastLine, ch: editor.getLine(lastLine).length };
        editor.replaceRange(`${prefix}${text}`, end);
        new Notice("已追加到当前笔记");
        return;
      }
      if (!activeFile) {
        new Notice("当前没有可写入的 Markdown 文件");
        return;
      }
      const current = await this.app.vault.read(activeFile);
      const prefix = current.trimEnd().length > 0 ? "\n\n" : "";
      await this.app.vault.modify(activeFile, `${current}${prefix}${text}`);
      await this.app.workspace.getLeaf("tab").openFile(activeFile);
      new Notice("已追加到当前笔记");
      return;
    }
    const parent = activeFile?.parent?.path ?? target.view?.file?.parent?.path ?? "";
    const stem = activeFile?.basename ? `${activeFile.basename} - Grok` : "Grok note";
    const path = await this.app.fileManager.getAvailablePathForAttachment(
      parent ? `${parent}/${stem}.md` : `${stem}.md`,
    );
    await this.app.vault.create(path, text);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
    new Notice("已新建笔记");
  }

  private async openSource(path: string): Promise<void> {
    if (path.startsWith("#")) {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: "search",
        active: true,
        state: { query: `tag:${path.slice(1)}` },
      });
      return;
    }
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (abstract instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(abstract);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: "search",
      active: true,
      state: { query: `path:"${path}"` },
    });
  }

  /** Delete plugin-managed screenshot files not referenced by any conversation. */
  async cleanupOrphanScreenshots(): Promise<number> {
    if (!this.settings.deleteAttachmentsOnCleanup) {
      new Notice("已关闭「清理时删除截图附件」");
      return 0;
    }
    const referenced = this.chatStore.allReferencedAttachmentPaths();
    for (const pending of this.pendingAttachments) referenced.add(pending.path);

    const candidates = this.app.vault
      .getFiles()
      .filter(
        (file) =>
          isPluginManagedScreenshot(file.name) &&
          ["png", "jpg", "jpeg", "webp", "gif"].includes(file.extension.toLowerCase()) &&
          !referenced.has(file.path),
      )
      .map((file) => file.path);

    return deleteVaultFiles(this.app, candidates);
  }
}
