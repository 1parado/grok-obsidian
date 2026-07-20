import { App, PluginSettingTab, Setting } from "obsidian";
import type GrokBuildPlugin from "./main";
import { resolveGrokBinary } from "./grokRunner";
import type { CustomPrompt } from "./chatTypes";
import { createId } from "./chatTypes";
import {
  DEFAULT_CONTEXT_LIMITS,
  type ContextLimitOverrides,
  mergeContextLimits,
} from "./contextLimits";
import { minutesInputToMs, msToMinutesDisplay } from "./timeoutFormat";

export interface GrokBuildSettings {
  /** Absolute path to grok / grok.exe. Empty = auto-detect. */
  grokPath: string;
  /** Absolute wall-clock timeout for one turn. */
  timeoutMs: number;
  /** Kill if no thought/text/progress for this many ms (capped by timeoutMs). */
  idleTimeoutMs: number;
  maxTurns: number;
  /** Comma-separated tools to disallow. Shell off by default for safety. */
  disallowedTools: string;
  /** Extra system rules appended via --rules */
  extraRules: string;
  includeActiveNoteByDefault: boolean;
  historyLimit: number;
  /** Delete vault screenshot files when removing attachments / conversations. */
  deleteAttachmentsOnCleanup: boolean;
  customPrompts: CustomPrompt[];
  /** Optional overrides for vault context caps. */
  contextLimits?: ContextLimitOverrides;
}

export const DEFAULT_SETTINGS: GrokBuildSettings = {
  grokPath: "",
  timeoutMs: 10 * 60 * 1000,
  idleTimeoutMs: 2 * 60 * 1000,
  maxTurns: 30,
  disallowedTools: "run_terminal_cmd",
  extraRules:
    "You are helping write and improve documentation inside an Obsidian vault. Prefer clear Markdown. Do not delete unrelated notes. Avoid running shell commands.",
  includeActiveNoteByDefault: true,
  historyLimit: 20,
  deleteAttachmentsOnCleanup: true,
  customPrompts: [
    {
      id: "summarize",
      name: "总结",
      prompt: "请总结下面的内容，提炼关键结论和行动项。",
      description: "提炼结论与行动项",
      isWorkflow: true,
    },
    {
      id: "polish",
      name: "润色",
      prompt: "请把下面的内容润色成清晰、自然的中文 Markdown。",
      description: "润色为清晰中文",
      isWorkflow: true,
    },
    {
      id: "translate",
      name: "翻译",
      prompt: "请将下面的内容翻译成中文，保留 Markdown 结构。",
      description: "译为中文并保留结构",
      isWorkflow: true,
    },
    {
      id: "meeting-notes",
      name: "会议纪要",
      prompt:
        "请根据下面的内容整理成会议纪要：议题、讨论要点、决议、待办（负责人/截止日期若可知）。使用清晰 Markdown。",
      description: "工作流：会议纪要",
      isWorkflow: true,
    },
    {
      id: "weekly-review",
      name: "周报复盘",
      prompt:
        "请把下面内容整理成周报复盘：本周进展、阻塞、下周计划、风险。条目化，适合直接贴进笔记。",
      description: "工作流：周报复盘",
      isWorkflow: true,
    },
  ],
  contextLimits: { ...DEFAULT_CONTEXT_LIMITS },
};

export class GrokBuildSettingTab extends PluginSettingTab {
  plugin: GrokBuildPlugin;

  constructor(app: App, plugin: GrokBuildPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Grok Obsidian" });
    containerEl.createEl("p", {
      text: "模型与权限跟随本机 Grok Build / CLI 配置。聊天默认只读（plan），写入仅通过 Diff 确认或显式插入笔记。",
      cls: "setting-item-description",
    });

    const resolution = resolveGrokBinary(this.plugin.settings);
    const sourceLabels = {
      custom: "用户指定",
      default: "默认位置",
      path: "系统 PATH",
      fallback: "尚未找到",
    } as const;
    new Setting(containerEl)
      .setName("当前 Grok CLI")
      .setDesc(`${sourceLabels[resolution.source]}：${resolution.path}。首次使用请先在终端执行 grok login。`)
      .addButton((button) =>
        button.setButtonText("重新检测").onClick(() => {
          void this.plugin.refreshDefaultModelPublic().then(() => this.display());
        }),
      )
      .addButton((button) =>
        button.setButtonText("测试命令").setCta().onClick(() => {
          void this.plugin.testGrokCliPublic();
        }),
      );

    new Setting(containerEl)
      .setName("默认附带当前笔记")
      .setDesc("新对话是否默认把最近聚焦的 Markdown 笔记作为上下文；每个对话也可在面板中单独切换。")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.includeActiveNoteByDefault).onChange(async (value) => {
          this.plugin.settings.includeActiveNoteByDefault = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("对话历史上限")
      .setDesc("本地最多保留多少个对话（置顶对话优先保留）。修改后立即生效。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.historyLimit)).onChange(async (value) => {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 1) return;
          this.plugin.settings.historyLimit = Math.floor(n);
          this.plugin.applyHistoryLimit(this.plugin.settings.historyLimit);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("清理时删除截图附件")
      .setDesc("移除待发送图片、删除对话，或执行「清理孤立截图」时，同步删除 Vault 中对应的 Grok Screenshot 文件。")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.deleteAttachmentsOnCleanup).onChange(async (value) => {
          this.plugin.settings.deleteAttachmentsOnCleanup = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("清理孤立截图")
      .setDesc("删除 Vault 中名为 Grok Screenshot 且未被任何对话引用的图片。")
      .addButton((button) =>
        button.setButtonText("立即清理").onClick(async () => {
          const count = await this.plugin.cleanupOrphanScreenshots();
          button.setButtonText(count > 0 ? `已删除 ${count} 个` : "没有可清理项");
          window.setTimeout(() => button.setButtonText("立即清理"), 2000);
        }),
      );

    // —— Structured custom prompts / workflows ——
    containerEl.createEl("h3", { text: "斜杠提示词与工作流" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "在输入框输入 / 可选用。标记为工作流的条目会在菜单中显示说明。",
    });

    const prompts = this.plugin.settings.customPrompts ?? [];
    for (let index = 0; index < prompts.length; index += 1) {
      const item = prompts[index];
      const row = containerEl.createDiv({ cls: "grok-settings-prompt-row" });
      new Setting(row)
        .setName(item.isWorkflow ? `工作流 · ${item.name || "未命名"}` : item.name || `提示词 ${index + 1}`)
        .setDesc(item.description || item.prompt.slice(0, 80))
        .addText((text) => {
          text.setPlaceholder("名称").setValue(item.name);
          text.onChange(async (value) => {
            item.name = value.trim() || item.name;
            await this.plugin.saveSettings();
          });
        })
        .addToggle((tg) =>
          tg.setTooltip("工作流").setValue(Boolean(item.isWorkflow)).onChange(async (value) => {
            item.isWorkflow = value;
            await this.plugin.saveSettings();
            this.display();
          }),
        )
        .addButton((btn) =>
          btn.setButtonText("删除").setWarning().onClick(async () => {
            this.plugin.settings.customPrompts = prompts.filter((_, i) => i !== index);
            await this.plugin.saveSettings();
            this.display();
          }),
        );
      new Setting(row)
        .setName("说明")
        .addText((text) => {
          text.setPlaceholder("可选说明").setValue(item.description ?? "");
          text.onChange(async (value) => {
            item.description = value.trim();
            await this.plugin.saveSettings();
          });
        });
      new Setting(row)
        .setName("提示词正文")
        .addTextArea((ta) => {
          ta.setValue(item.prompt);
          ta.inputEl.rows = 3;
          ta.inputEl.style.width = "100%";
          ta.onChange(async (value) => {
            item.prompt = value;
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("添加提示词").setCta().onClick(async () => {
        this.plugin.settings.customPrompts.push({
          id: createId("prompt"),
          name: "新提示词",
          prompt: "请根据下面的内容……",
          description: "",
          isWorkflow: false,
        });
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    // —— Advanced (collapsed) ——
    const advanced = containerEl.createEl("details", { cls: "grok-settings-advanced" });
    advanced.createEl("summary", { text: "高级选项" });
    const advancedBody = advanced.createDiv({ cls: "grok-settings-advanced-body" });

    advancedBody.createEl("p", {
      cls: "setting-item-description",
      text: "一般无需修改。模型请在 Grok Build / CLI 中配置，插件始终使用 CLI 默认模型。",
    });

    new Setting(advancedBody)
      .setName("Grok 可执行文件路径")
      .setDesc("可选。留空时依次检查 ~/.grok/bin 和系统 PATH；填写后优先使用。")
      .addText((text) =>
        text
          .setPlaceholder("留空即可自动检测")
          .setValue(this.plugin.settings.grokPath)
          .onChange(async (value) => {
            this.plugin.settings.grokPath = value.trim();
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(advancedBody)
      .setName("总超时（分钟）")
      .setDesc("整轮请求最长等待时间。最小约 0.2 分钟（10 秒）。")
      .addText((text) =>
        text
          .setValue(msToMinutesDisplay(this.plugin.settings.timeoutMs))
          .onChange(async (value) => {
            const ms = minutesInputToMs(value, 10_000);
            if (ms == null) return;
            this.plugin.settings.timeoutMs = ms;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(advancedBody)
      .setName("无进度超时（分钟）")
      .setDesc("连续无思考/输出进度超过该时间则终止。最小约 0.1 分钟（5 秒），默认 2 分钟。")
      .addText((text) =>
        text
          .setValue(
            msToMinutesDisplay(this.plugin.settings.idleTimeoutMs ?? DEFAULT_SETTINGS.idleTimeoutMs),
          )
          .onChange(async (value) => {
            const ms = minutesInputToMs(value, 5_000);
            if (ms == null) return;
            this.plugin.settings.idleTimeoutMs = ms;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(advancedBody)
      .setName("最大回合数")
      .setDesc("限制 agent 循环长度（文本与图片会话均生效）。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxTurns)).onChange(async (value) => {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 1) return;
          this.plugin.settings.maxTurns = Math.floor(n);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(advancedBody)
      .setName("禁用工具")
      .setDesc("逗号分隔。默认禁用 shell：run_terminal_cmd")
      .addText((text) =>
        text.setValue(this.plugin.settings.disallowedTools).onChange(async (value) => {
          this.plugin.settings.disallowedTools = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(advancedBody)
      .setName("额外规则")
      .setDesc("传给 grok --rules。用于风格与安全指引（与 CLI 全局规则叠加）。")
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.extraRules).onChange(async (value) => {
          this.plugin.settings.extraRules = value;
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 4;
        ta.inputEl.style.width = "100%";
      });

    advancedBody.createEl("h4", { text: "上下文上限" });
    advancedBody.createEl("p", {
      cls: "setting-item-description",
      text: "控制每轮读入 Vault 的规模；发送与摘要共用同一套限制。",
    });

    const limits = mergeContextLimits(this.plugin.settings.contextLimits);
    const limitFields: Array<{ key: keyof typeof DEFAULT_CONTEXT_LIMITS; name: string; desc: string }> = [
      { key: "maxFilesInMessage", name: "消息内 @ 文件数", desc: "单条消息最多解析的文件提及" },
      { key: "maxFoldersInMessage", name: "消息内文件夹数", desc: "单条消息最多解析的文件夹提及" },
      { key: "maxTagsInMessage", name: "消息内标签数", desc: "单条消息最多解析的标签" },
      { key: "maxExpandedPaths", name: "展开路径总数", desc: "文件夹/标签展开后的最大路径数" },
      { key: "maxFilesPerFolder", name: "每文件夹文件数", desc: "单个文件夹最多展开的文件" },
      { key: "maxFilesPerTag", name: "每标签文件数", desc: "单个标签最多展开的文件" },
      { key: "maxCharsPerFile", name: "单文件字符上限", desc: "每个文件最多读入的字符数" },
      { key: "maxCharsTotal", name: "总字符上限", desc: "本轮 Vault 正文合计字符上限" },
    ];

    for (const field of limitFields) {
      new Setting(advancedBody)
        .setName(field.name)
        .setDesc(field.desc)
        .addText((text) =>
          text.setValue(String(limits[field.key])).onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 1) return;
            const next = { ...(this.plugin.settings.contextLimits ?? {}), [field.key]: Math.floor(n) };
            this.plugin.settings.contextLimits = mergeContextLimits(next);
            await this.plugin.saveSettings();
          }),
        );
    }
  }
}
