import { App, Modal, Notice, Setting, TFile } from "obsidian";
import {
  buildSimpleDiff,
  countDiffStats,
  kindLabel,
  materializeChange,
  parseProposedChanges,
  type ChangeKind,
  type ProposedChange,
  type ResolvedChange,
} from "./diffUtils";

type ResolvedWithState = ResolvedChange & { applied?: boolean };

export class ApplyDiffModal extends Modal {
  private resolved: ResolvedWithState[] = [];
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private activePath: string | null = null;
  private appliedCount = 0;

  constructor(
    app: App,
    private readonly responseText: string,
    private readonly fallbackPath: string | undefined,
    private readonly onApplied: (summary: string) => void,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    modalEl.addClass("grok-diff-modal-window");
    contentEl.addClass("grok-diff-modal");
    contentEl.createEl("h2", { text: "预览并应用更改" });
    contentEl.createDiv({
      cls: "grok-diff-hint",
      text: "可逐个文件审批，或勾选后一键应用全部。左侧点选文件，右侧查看差异。",
    });

    const proposed = parseProposedChanges(this.responseText, {
      fallbackPath: this.fallbackPath,
    });

    if (proposed.length === 0) {
      contentEl.createDiv({
        cls: "grok-diff-empty",
        text: "回答中没有可解析的文件更改。可让模型按「路径 + 代码块」输出全文，或对已有文件使用 SEARCH/REPLACE 局部块。",
      });
      new Setting(contentEl).addButton((button) =>
        button.setButtonText("关闭").onClick(() => this.close()),
      );
      return;
    }

    this.resolved = await Promise.all(proposed.map((change) => this.resolveChange(change)));
    this.activePath = this.resolved[0]?.change.path ?? null;

    const body = contentEl.createDiv({ cls: "grok-diff-body" });
    this.listEl = body.createDiv({ cls: "grok-diff-file-list" });
    this.detailEl = body.createDiv({ cls: "grok-diff-detail" });
    this.footerEl = contentEl.createDiv({ cls: "grok-diff-footer" });
    this.renderAll();
  }

  private renderAll(): void {
    this.renderList();
    this.renderDetail();
    this.renderFooter();
  }

  private async resolveChange(change: ProposedChange): Promise<ResolvedWithState> {
    const abstract = this.app.vault.getAbstractFileByPath(change.path);
    const exists = abstract instanceof TFile;
    const before = exists ? await this.app.vault.read(abstract) : "";
    const materialized = materializeChange(before, change, exists);
    if (!materialized.ok) {
      return {
        change: { ...change, kind: change.kind },
        exists,
        before,
        after: before,
        stats: { added: 0, removed: 0 },
        error: materialized.error,
        selected: false,
        applied: false,
      };
    }
    const kind: ChangeKind = materialized.kind;
    const after = materialized.after;
    const unchanged = exists && before === after;
    return {
      change: { ...change, kind, content: kind === "partial" ? undefined : after },
      exists,
      before,
      after,
      stats: countDiffStats(before, after),
      error: unchanged ? "没有实际变化" : undefined,
      selected: !unchanged,
      applied: false,
    };
  }

  private renderList(): void {
    this.listEl.empty();
    for (const item of this.resolved) {
      const row = this.listEl.createDiv({
        cls: [
          "grok-diff-file-row",
          item.change.path === this.activePath ? "is-active" : "",
          item.error ? "is-error" : "",
          item.applied ? "is-applied" : "",
        ]
          .filter(Boolean)
          .join(" "),
      });

      const check = row.createEl("input", {
        attr: {
          type: "checkbox",
          ...(item.selected && !item.applied ? { checked: "true" } : {}),
          ...(item.error || item.applied ? { disabled: "true" } : {}),
        },
      });
      check.addEventListener("click", (event) => event.stopPropagation());
      check.addEventListener("change", () => {
        item.selected = check.checked;
        this.renderFooter();
      });

      const main = row.createDiv({ cls: "grok-diff-file-main" });
      main.createDiv({
        cls: "grok-diff-file-path",
        text: item.change.path,
      });
      const meta = [
        item.applied ? "已应用" : kindLabel(item.change.kind, item.exists),
        item.error
          ? item.error
          : `+${item.stats.added} / -${item.stats.removed}`,
      ].join(" · ");
      main.createDiv({ cls: "grok-diff-file-meta", text: meta });

      row.addEventListener("click", () => {
        this.activePath = item.change.path;
        this.renderList();
        this.renderDetail();
      });
    }
  }

  private renderDetail(): void {
    this.detailEl.empty();
    const item = this.resolved.find((entry) => entry.change.path === this.activePath);
    if (!item) {
      this.detailEl.createDiv({ cls: "grok-diff-empty", text: "选择左侧文件查看差异" });
      return;
    }

    this.detailEl.createDiv({
      cls: "grok-diff-target",
      text: `${item.change.path} · ${item.applied ? "已应用" : kindLabel(item.change.kind, item.exists)}`,
    });

    if (item.applied) {
      this.detailEl.createDiv({
        cls: "grok-diff-stats",
        text: "此文件已写入 Vault。可继续审批其它文件，或关闭。",
      });
    }

    if (item.error) {
      this.detailEl.createDiv({ cls: "grok-diff-empty", text: item.error });
      if (item.change.kind === "partial" && item.change.replacements?.length) {
        const preview = this.detailEl.createEl("pre", { cls: "grok-diff-preview" });
        for (const [index, rep] of item.change.replacements.entries()) {
          preview.createDiv({
            cls: "grok-diff-line",
            text: `--- SEARCH #${index + 1} ---`,
          });
          for (const line of rep.search.split("\n")) {
            preview.createDiv({ cls: "grok-diff-line is-removed", text: `- ${line}` });
          }
          preview.createDiv({
            cls: "grok-diff-line",
            text: `--- REPLACE #${index + 1} ---`,
          });
          for (const line of rep.replace.split("\n")) {
            preview.createDiv({ cls: "grok-diff-line is-added", text: `+ ${line}` });
          }
        }
      }
      return;
    }

    if (!item.applied) {
      this.detailEl.createDiv({
        cls: "grok-diff-stats",
        text: `+${item.stats.added} / -${item.stats.removed} 行。可单独应用此文件，或勾选后一键应用全部。`,
      });
    }

    const diff = this.detailEl.createEl("pre", { cls: "grok-diff-preview" });
    for (const line of buildSimpleDiff(item.before, item.after).split("\n")) {
      diff.createDiv({
        cls: line.startsWith("+ ")
          ? "grok-diff-line is-added"
          : line.startsWith("- ")
            ? "grok-diff-line is-removed"
            : "grok-diff-line",
        text: line,
      });
    }

    if (!item.applied && !item.error) {
      const actions = this.detailEl.createDiv({ cls: "grok-diff-file-actions" });
      const applyOne = actions.createEl("button", {
        cls: "mod-cta",
        text: "应用此文件",
      });
      applyOne.addEventListener("click", () => void this.applyItems([item], true));

      const skip = actions.createEl("button", { text: "跳过，下一个" });
      skip.addEventListener("click", () => this.focusNextPending(item.change.path));
    }
  }

  private renderFooter(): void {
    this.footerEl.empty();
    const pending = this.resolved.filter((item) => !item.error && !item.applied);
    const selected = pending.filter((item) => item.selected);

    const bar = new Setting(this.footerEl);
    bar.setDesc(
      pending.length
        ? `待处理 ${pending.length} · 已勾选 ${selected.length} · 已应用 ${this.appliedCount}`
        : `全部处理完毕 · 已应用 ${this.appliedCount}`,
    );
    bar.addButton((button) => button.setButtonText("关闭").onClick(() => this.close()));
    if (pending.length) {
      bar.addButton((button) =>
        button.setButtonText("全选待处理").onClick(() => {
          for (const item of pending) item.selected = true;
          this.renderAll();
        }),
      );
      bar.addButton((button) =>
        button
          .setButtonText(selected.length ? `一键应用所选 (${selected.length})` : "一键应用全部待处理")
          .setCta()
          .onClick(() => {
            const targets = selected.length ? selected : pending;
            void this.applyItems(targets, false);
          }),
      );
    }
  }

  private focusNextPending(fromPath: string): void {
    const pending = this.resolved.filter((item) => !item.error && !item.applied);
    const index = pending.findIndex((item) => item.change.path === fromPath);
    const next = pending[index + 1] ?? pending[0];
    if (next) {
      this.activePath = next.change.path;
      this.renderAll();
    }
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const parts = filePath.split("/").slice(0, -1);
    if (parts.length === 0) return;
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async applyOne(item: ResolvedWithState): Promise<string | null> {
    if (item.error || item.applied) return item.error ?? null;
    try {
      const abstract = this.app.vault.getAbstractFileByPath(item.change.path);
      if (item.change.kind === "partial") {
        if (!(abstract instanceof TFile)) return "文件不存在";
        const latest = await this.app.vault.read(abstract);
        const result = materializeChange(latest, item.change, true);
        if (!result.ok) return result.error;
        await this.app.vault.modify(abstract, result.after);
      } else {
        const body = item.after;
        if (abstract instanceof TFile) {
          await this.app.vault.modify(abstract, body);
        } else {
          await this.ensureFolder(item.change.path);
          await this.app.vault.create(item.change.path, body);
        }
      }
      item.applied = true;
      item.selected = false;
      this.appliedCount += 1;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async applyItems(items: ResolvedWithState[], advance: boolean): Promise<void> {
    const targets = items.filter((item) => !item.error && !item.applied);
    if (targets.length === 0) {
      new Notice("没有可应用的更改");
      return;
    }

    const applied: string[] = [];
    const failed: string[] = [];

    for (const item of targets) {
      const err = await this.applyOne(item);
      if (err) failed.push(`${item.change.path}（${err}）`);
      else applied.push(item.change.path);
    }

    if (applied.length) {
      const firstFile = this.app.vault.getAbstractFileByPath(applied[0]);
      if (firstFile instanceof TFile) {
        try {
          await this.app.workspace.getLeaf(false).openFile(firstFile);
        } catch {
          /* ignore */
        }
      }
      this.onApplied(
        failed.length
          ? `已应用 ${applied.length} 个文件；失败 ${failed.length} 个`
          : `已应用 ${applied.length} 个文件`,
      );
    }
    if (failed.length) {
      new Notice(`部分失败：${failed.slice(0, 3).join("；")}${failed.length > 3 ? "…" : ""}`);
    }

    const remaining = this.resolved.some((item) => !item.error && !item.applied);
    if (!remaining) {
      this.close();
      return;
    }

    if (advance && applied.length) {
      this.focusNextPending(applied[applied.length - 1]);
    } else {
      this.renderAll();
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
