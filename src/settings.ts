import { App, PluginSettingTab, Setting } from "obsidian";
import type GrokBuildPlugin from "./main";
import { resolveGrokBinary } from "./grokRunner";
import type { CustomPrompt } from "./chatTypes";

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
    { id: "summarize", name: "总结", prompt: "请总结下面的内容，提炼关键结论和行动项。" },
    { id: "polish", name: "润色", prompt: "请把下面的内容润色成清晰、自然的中文 Markdown。" },
    { id: "translate", name: "翻译", prompt: "请将下面的内容翻译成中文，保留 Markdown 结构。" },
  ],
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
      text: "模型与权限跟随本机 Grok Build / CLI 配置。聊天默认只读（plan），写入仅通过 Diff 确认。",
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
      .setDesc(`${sourceLabels[resolution.source]}：${resolution.path}`)
      .addButton((button) =>
        button.setButtonText("重新检测").onClick(() => {
          this.display();
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
      .setDesc("本地最多保留多少个对话。修改后立即生效。")
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

    new Setting(containerEl)
      .setName("斜杠提示词")
      .setDesc("每行一个：名称=提示词。输入 / 可选择。")
      .addTextArea((ta) => {
        ta.setValue(
          this.plugin.settings.customPrompts.map((item) => `${item.name}=${item.prompt}`).join("\n"),
        );
        ta.inputEl.rows = 5;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.customPrompts = value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, index) => {
              const separator = line.indexOf("=");
              const name = separator > 0 ? line.slice(0, separator).trim() : `提示词 ${index + 1}`;
              const prompt = separator > 0 ? line.slice(separator + 1).trim() : line;
              return { id: `custom-${index}`, name, prompt };
            });
          await this.plugin.saveSettings();
        });
      });

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
      .setName("总超时（毫秒）")
      .setDesc("整轮请求最长等待时间。最小 10000。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.timeoutMs)).onChange(async (value) => {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 10_000) return;
          this.plugin.settings.timeoutMs = Math.floor(n);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(advancedBody)
      .setName("无进度超时（毫秒）")
      .setDesc("连续无思考/输出进度超过该时间则终止（会被总超时上限截断）。最小 5000，默认 120000。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.idleTimeoutMs ?? DEFAULT_SETTINGS.idleTimeoutMs))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 5_000) return;
            this.plugin.settings.idleTimeoutMs = Math.floor(n);
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
  }
}
