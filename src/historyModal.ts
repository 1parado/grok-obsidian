import { App, Modal, Notice, setIcon } from "obsidian";
import type { ChatConversation } from "./chatTypes";

export class ChatHistoryModal extends Modal {
  private listEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private query = "";

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
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("grok-history-modal");
    contentEl.createEl("h2", { text: "对话历史" });
    contentEl.createDiv({
      cls: "grok-history-hint",
      text: "搜索标题 · 点击打开 · 可重命名 / 导出 Markdown / 删除",
    });

    this.searchEl = contentEl.createEl("input", {
      cls: "grok-history-search",
      attr: {
        type: "search",
        placeholder: "按标题搜索…",
        "aria-label": "按标题搜索对话",
      },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim().toLocaleLowerCase();
      this.renderList();
    });

    this.listEl = contentEl.createDiv({ cls: "grok-history-list" });
    this.renderList();
    this.searchEl.focus();
  }

  private filtered(): ChatConversation[] {
    if (!this.query) return this.conversations;
    return this.conversations.filter((item) =>
      (item.title || "未命名对话").toLocaleLowerCase().includes(this.query),
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
      const row = this.listEl.createDiv({ cls: "grok-history-row" });
      const main = row.createEl("button", {
        cls: "grok-history-main",
        attr: { type: "button", title: "打开此对话" },
      });
      main.createDiv({ cls: "grok-history-title", text: item.title || "未命名对话" });
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

      const rename = actions.createEl("button", {
        cls: "grok-history-action clickable-icon",
        attr: { type: "button", "aria-label": "重命名", title: "重命名" },
      });
      setIcon(rename, "pencil");
      rename.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = window.prompt("重命名对话", item.title || "未命名对话");
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
        const confirmed = window.confirm(
          `确定删除对话「${title}」？\n此操作会移除本地记录，并可能清理关联截图附件。`,
        );
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
