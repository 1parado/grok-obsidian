import { App, Modal, Setting } from "obsidian";

/** Obsidian-style confirm dialog (replaces window.confirm). */
export class ConfirmModal extends Modal {
  private result: boolean | null = null;
  private resolveFn: ((value: boolean) => void) | null = null;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly bodyText: string,
    private readonly confirmLabel = "确定",
    private readonly cancelLabel = "取消",
    private readonly danger = false,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("grok-confirm-modal");
    contentEl.createEl("h2", { text: this.titleText });
    contentEl.createDiv({ cls: "grok-confirm-body", text: this.bodyText });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(this.cancelLabel).onClick(() => {
          this.result = false;
          this.close();
        }),
      )
      .addButton((btn) => {
        btn.setButtonText(this.confirmLabel).setCta();
        if (this.danger) btn.setWarning();
        btn.onClick(() => {
          this.result = true;
          this.close();
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn?.(this.result === true);
    this.resolveFn = null;
  }

  wait(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolveFn = resolve;
      this.open();
    });
  }
}

/** Obsidian-style prompt for a single text value (replaces window.prompt). */
export class PromptModal extends Modal {
  private value: string;
  private resolved = false;
  private resolveFn: ((value: string | null) => void) | null = null;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly initial: string,
    private readonly placeholder = "",
  ) {
    super(app);
    this.value = initial;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("grok-prompt-modal");
    contentEl.createEl("h2", { text: this.titleText });
    const input = contentEl.createEl("input", {
      cls: "grok-prompt-input",
      attr: { type: "text", placeholder: this.placeholder },
    });
    input.value = this.initial;
    input.addEventListener("input", () => {
      this.value = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.resolved = true;
        this.close();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.value = "";
        this.resolved = false;
        this.close();
      }
    });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("取消").onClick(() => {
          this.resolved = false;
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("确定")
          .setCta()
          .onClick(() => {
            this.resolved = true;
            this.close();
          }),
      );
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 20);
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn?.(this.resolved ? this.value : null);
    this.resolveFn = null;
  }

  wait(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolveFn = resolve;
      this.open();
    });
  }
}
