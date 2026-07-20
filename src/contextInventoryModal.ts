import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import type { ContextInventory, ContextInventoryItem } from "./contextInventory";

const ITEM_ICON: Record<ContextInventoryItem["kind"], string> = {
  "active-note": "file-text",
  "open-tab": "layers",
  file: "file-text",
  folder: "folder",
  tag: "hash",
  selection: "scan-text",
  image: "image",
  expanded: "list-tree",
};

export class ContextInventoryModal extends Modal {
  constructor(
    app: App,
    private readonly inventory: ContextInventory,
    private readonly onOpenSource?: (path: string) => void | Promise<void>,
    private readonly onRemoveItem?: (item: ContextInventoryItem) => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("grok-context-inventory-modal");
    contentEl.createEl("h2", { text: "本轮上下文" });
    contentEl.createDiv({
      cls: `grok-context-inventory-summary${this.inventory.truncated ? " is-truncated" : ""}`,
      text: this.inventory.line,
    });
    if (this.inventory.truncationReasons.length > 0) {
      const reasons = contentEl.createDiv({ cls: "grok-context-inventory-reasons" });
      reasons.createDiv({ cls: "grok-context-inventory-reasons-title", text: "截断原因" });
      for (const reason of this.inventory.truncationReasons) {
        reasons.createDiv({ cls: "grok-context-inventory-reason", text: reason });
      }
    }

    const list = contentEl.createDiv({ cls: "grok-context-inventory-list" });
    if (this.inventory.items.length === 0) {
      list.createDiv({ cls: "grok-context-inventory-empty", text: "本轮无额外上下文" });
    } else {
      for (const item of this.inventory.items) {
        this.renderItem(list, item);
      }
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("复制清单").onClick(() => void this.copyInventory()),
      )
      .addButton((button) =>
        button.setButtonText("关闭").onClick(() => this.close()),
      );
  }

  private renderItem(parent: HTMLElement, item: ContextInventoryItem): void {
    const clickable = Boolean(item.path && this.onOpenSource);
    const row = parent.createDiv({
      cls: `grok-context-inventory-item${item.truncated ? " is-truncated" : ""}`,
    });
    const main = row.createEl(clickable ? "button" : "div", {
      cls: `grok-context-inventory-main${clickable ? " is-clickable" : ""}`,
      attr: clickable ? { type: "button", title: item.path } : {},
    });
    const icon = main.createSpan({ cls: "grok-context-inventory-icon" });
    setIcon(icon, ITEM_ICON[item.kind]);
    const text = main.createSpan({ cls: "grok-context-inventory-text" });
    text.createSpan({ cls: "grok-context-inventory-label", text: item.label });
    if (item.detail || item.path) {
      text.createSpan({
        cls: "grok-context-inventory-detail",
        text: [item.detail, item.path].filter(Boolean).join(" · "),
      });
    }
    if (item.truncated) {
      main.createSpan({ cls: "grok-context-inventory-badge", text: "截断" });
    }
    if (item.removable && this.onRemoveItem) {
      const remove = row.createEl("button", {
        cls: "grok-context-inventory-remove clickable-icon",
        attr: { type: "button", title: "移除此上下文", "aria-label": "移除此上下文" },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.onRemoveItem?.(item);
        this.close();
      });
    }
    if (clickable) {
      main.addEventListener("click", () => {
        void this.onOpenSource?.(item.path);
        this.close();
      });
    }
  }

  private async copyInventory(): Promise<void> {
    const lines = [
      `本轮上下文：${this.inventory.line}`,
      "",
      ...this.inventory.items.map((item) => {
        const detail = [item.detail, item.path].filter(Boolean).join(" · ");
        return `- ${item.label}${detail ? `：${detail}` : ""}${item.truncated ? "（截断）" : ""}`;
      }),
      ...(this.inventory.truncationReasons.length
        ? ["", "截断原因：", ...this.inventory.truncationReasons.map((reason) => `- ${reason}`)]
        : []),
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    new Notice("已复制上下文清单");
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
