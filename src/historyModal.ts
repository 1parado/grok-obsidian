import { App, Modal, Notice, setIcon } from "obsidian";
import type { ChatConversation } from "./chatTypes";
import { filterConversationsByQuery, sortConversationsForHistory } from "./historyFilter";
import { ConfirmModal, PromptModal } from "./confirmModal";

export class ChatHistoryModal extends Modal {
  private listEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private query = "";
  private runningConversationId: string | null = null;

  constructor(
    app: App,
    private conversations: ChatConversation[],
    private readonly onSelectConversation: (conversation: ChatConversation) => void,
    private readonly onDeleteConversation: (conversation: ChatConversation) => void | Promise<void>,
    private readonly onRenameConversation: (
      conversation: ChatConversation,
      title: string,
    ) => boolean | Promise<boolean>,
    private readonly onExportConversation: (
      conversation: ChatConversation,
    ) => void | Promise<void>,
    private readonly onPinConversation?: (
      conversation: ChatConversation,
      pinned: boolean,
    ) => boolean | Promise<boolean>,
    options?: { runningConversationId?: string | null },
  ) {
    super(app);
    this.runningConversationId = options?.runningConversationId ?? null;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("grok-history-modal");
    contentEl.createEl("h2", { text: "对话历史" });
    contentEl.createDiv({
      cls: "grok-history-hint",
      text: "搜索标题与正文 · 点击打开 · 可置顶 / 重命名 / 导出 / 删除",
    });
    if (this.runningConversationId) {
      contentEl.createDiv({
        cls: "grok-history-running-hint",
        text: "有任务在运行：切换历史不会中断当前生成；完成后会保留在原对话中。",
      });
    }

    this.searchEl = contentEl.createEl("input", {
      cls: "grok-history-search",
      attr: {
        type: "search",
        placeholder: "按标题或消息正文搜索…",
        "aria-label": "按标题或消息正文搜索对话",
      },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim();
      this.renderList();
    });

    this.listEl = contentEl.createDiv({ cls: "grok-history-list" });
    this.renderList();
    this.searchEl.focus();
  }

  private filtered(): ChatConversation[] {
    return sortConversationsForHistory(
      filterConversationsByQuery(this.conversations, this.query),
    );
  }

  private renderList(): void {
    this.listEl.empty();
    const items = this.filtered();
    if (items.length === 0) {
      this.listEl.createDiv({
        cls: "grok-history-empty",
        text: this.query ? "没有匹配的对话" : "暂无对话",
      });
      return;
    }

    for (const item of items) {
      const row = this.listEl.createDiv({
        cls: [
          "grok-history-row",
          item.pinned ? "is-pinned" : "",
          item.id === this.runningConversationId ? "is-running" : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
      const main = row.createEl("button", {
        cls: "grok-history-main",
        attr: { type: "button", title: "打开此对话" },
      });
      const titleRow = main.createDiv({ cls: "grok-history-title-row" });
      if (item.pinned) {
        titleRow.createSpan({ cls: "grok-history-pin-badge", text: "置顶" });
      }
      if (item.id === this.runningConversationId) {
        titleRow.createSpan({ cls: "grok-history-running-badge", text: "生成中" });
      }
      titleRow.createDiv({ cls: "grok-history-title", text: item.title || "未命名对话" });
      const date = new Date(item.updatedAt).toLocaleString();
      main.createDiv({
        cls: "grok-history-meta",
        text: `${date} · ${item.messages.length} 条消息`,
      });
      main.addEventListener("click", () => {
        this.onSelectConversation(item);
        this.close();
      });

      const actions = row.createDiv({ cls: "grok-history-actions" });

      if (this.onPinConversation) {
        const pin = actions.createEl("button", {
          cls: "grok-history-action clickable-icon",
          attr: {
            type: "button",
            "aria-label": item.pinned ? "取消置顶" : "置顶",
            title: item.pinned ? "取消置顶" : "置顶",
          },
        });
        setIcon(pin, item.pinned ? "pin-off" : "pin");
        pin.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const ok = await this.onPinConversation?.(item, !item.pinned);
          if (ok) {
            item.pinned = !item.pinned;
            this.renderList();
            new Notice(item.pinned ? "已置顶" : "已取消置顶");
          }
        });
      }

      const rename = actions.createEl("button", {
        cls: "grok-history-action clickable-icon",
        attr: { type: "button", "aria-label": "重命名", title: "重命名" },
      });
      setIcon(rename, "pencil");
      rename.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = await new PromptModal(
          this.app,
          "重命名对话",
          item.title || "未命名对话",
          "对话标题",
        ).wait();
        if (next == null) return;
        const ok = await this.onRenameConversation(item, next);
        if (ok) {
          item.title = next.trim().slice(0, 80) || item.title;
          this.renderList();
          new Notice("已重命名");
        } else {
          new Notice("重命名失败");
        }
      });

      const exp = actions.createEl("button", {
        cls: "grok-history-action clickable-icon",
        attr: { type: "button", "aria-label": "导出 Markdown", title: "导出 Markdown" },
      });
      setIcon(exp, "download");
      exp.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.onExportConversation(item);
      });

      const del = actions.createEl("button", {
        cls: "grok-history-action grok-history-delete clickable-icon",
        attr: { type: "button", "aria-label": "删除对话", title: "删除对话" },
      });
      setIcon(del, "trash-2");
      del.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const title = item.title || "未命名对话";
        const confirmed = await new ConfirmModal(
          this.app,
          "删除对话",
          `确定删除对话「${title}」？\n此操作会移除本地记录，并可能清理关联截图附件。`,
          "删除",
          "取消",
          true,
        ).wait();
        if (!confirmed) return;
        await this.onDeleteConversation(item);
        this.conversations = this.conversations.filter((c) => c.id !== item.id);
        this.renderList();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
