import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { terminateProcessTree } from "./processTree";
import { resolveIdleTimeoutMs, RunWatchdog } from "./runWatchdog";
import type { GrokBuildSettings } from "./settings";

export type PetStage = "idle" | "starting" | "thinking" | "writing" | "done" | "error" | "cancelled";

export interface GrokProgressEvent {
  stage: PetStage;
  /** 0–100 when estimable; null = indeterminate */
  progress: number | null;
  message: string;
  logLine?: string;
  logKind?: "thought" | "text" | "meta" | "error";
  partialText?: string;
  /** Accumulated thought/reasoning text when available. */
  partialThought?: string;
}

export interface GrokRunRequest {
  prompt: string;
  cwd: string;
  settings: GrokBuildSettings;
  /** Resume a previous Grok session so Pet chat can keep conversational context. */
  resumeSessionId?: string;
  onProgress: (ev: GrokProgressEvent) => void;
}

export interface GrokRunResult {
  ok: boolean;
  text: string;
  error?: string;
  sessionId?: string;
  exitCode: number | null;
}

export interface GrokBinaryResolution {
  path: string;
  source: "custom" | "default" | "path" | "fallback";
  found: boolean;
}

function expandConfiguredPath(value: string): string {
  const unquoted = value.trim().replace(/^(["'])(.*)\1$/, "$2");
  const expandedEnv = unquoted.replace(/%([^%]+)%/g, (_match, name: string) => {
    return process.env[name] ?? process.env[name.toUpperCase()] ?? `%${name}%`;
  });
  if (expandedEnv === "~") return os.homedir();
  if (expandedEnv.startsWith(`~${path.sep}`) || expandedEnv.startsWith("~/")) {
    return path.join(os.homedir(), expandedEnv.slice(2));
  }
  return expandedEnv;
}

/**
 * Resolve Grok in this order: user override, the official ~/.grok/bin location,
 * then every directory visible in Obsidian's PATH.
 */
export function resolveGrokBinary(settings: Pick<GrokBuildSettings, "grokPath">): GrokBinaryResolution {
  if (settings.grokPath) {
    const configured = expandConfiguredPath(settings.grokPath);
    return { path: configured, source: "custom", found: fs.existsSync(configured) };
  }

  const home = os.homedir();
  const defaultCandidates =
    process.platform === "win32"
      ? [path.join(home, ".grok", "bin", "grok.exe")]
      : [path.join(home, ".grok", "bin", "grok")];
  for (const candidate of defaultCandidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, source: "default", found: true };
    }
  }

  const executableNames = process.platform === "win32" ? ["grok.exe", "grok"] : ["grok"];
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const cleanEntry = entry.replace(/^(["'])(.*)\1$/, "$2");
    for (const name of executableNames) {
      const candidate = path.join(cleanEntry, name);
      if (fs.existsSync(candidate)) {
        return { path: candidate, source: "path", found: true };
      }
    }
  }

  return {
    path: process.platform === "win32" ? "grok.exe" : "grok",
    source: "fallback",
    found: false,
  };
}

export async function detectDefaultGrokModel(
  settings: Pick<GrokBuildSettings, "grokPath">,
): Promise<string | null> {
  const binary = resolveGrokBinary(settings).path;
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (model: string | null) => {
      if (settled) return;
      settled = true;
      resolve(model);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, ["models"], {
        env: { ...process.env },
        windowsHide: true,
        shell: false,
      });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      finish(null);
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.once("close", () => {
      clearTimeout(timer);
      const model = output.match(/Default model:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;
      finish(model);
    });
  });
}

export async function testGrokCli(
  settings: Pick<GrokBuildSettings, "grokPath">,
  timeoutMs = 8_000,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const resolution = resolveGrokBinary(settings);
  if (!resolution.found) {
    return {
      ok: false,
      message: `未检测到 grok：${resolution.path}。请先安装 Grok CLI，执行 grok login，或在设置中填写绝对路径。`,
    };
  }

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      resolve(ok ? { ok: true, message } : { ok: false, message });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(resolution.path, ["-p", "hi", "--output-format", "plain"], {
        env: { ...process.env },
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      finish(false, `无法启动 grok：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const timer = setTimeout(() => {
      terminateProcessTree(child);
      finish(false, "grok 测试超时。若首次使用，请确认已在终端执行 grok login。");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      finish(false, `grok 测试失败：${error.message}`);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const trimmed = output.trim();
      if (code === 0) {
        finish(true, `grok CLI 可用：${resolution.path}`);
      } else {
        finish(
          false,
          `grok 测试退出码 ${code ?? "未知"}。请确认已执行 grok login。${trimmed ? `\n${trimmed.slice(0, 500)}` : ""}`,
        );
      }
    });
  });
}

function buildArgs(
  promptFile: string,
  settings: GrokBuildSettings,
  resumeSessionId?: string,
): string[] {
  const args: string[] = [
    "--prompt-file",
    promptFile,
    "--output-format",
    "streaming-json",
    "--max-turns",
    String(settings.maxTurns),
    // Chat turns are read-only. The explicit Diff action is the only write path.
    "--permission-mode",
    "plan",
  ];

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  // Model is never overridden by the plugin — use CLI / Grok Build default.
  if (settings.disallowedTools) {
    args.push("--disallowed-tools", settings.disallowedTools);
  }
  if (settings.extraRules) {
    args.push("--rules", settings.extraRules);
  }
  // Never enable full YOLO by default in this plugin.
  return args;
}

export class GrokRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private killed = false;
  private terminationError: string | null = null;

  cancel(): void {
    this.killed = true;
    this.terminationError = null;
    this.terminateChild();
  }

  private terminateChild(): void {
    terminateProcessTree(this.child);
  }

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  async run(req: GrokRunRequest): Promise<GrokRunResult> {
    this.killed = false;
    this.terminationError = null;
    const resolution = resolveGrokBinary(req.settings);
    const bin = resolution.path;
    const promptFile = path.join(
      os.tmpdir(),
      `obsidian-grok-build-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    fs.writeFileSync(promptFile, req.prompt, "utf8");

    const args = buildArgs(promptFile, req.settings, req.resumeSessionId);

    req.onProgress({
      stage: "starting",
      progress: 5,
      message: "正在启动本地 Grok…",
      logLine: `${bin} ${args.filter((a) => a !== req.prompt).join(" ")}`.slice(0, 400),
      logKind: "meta",
    });

    return new Promise((resolve) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      let finalText = "";
      let sessionId: string | undefined;
      let sawEnd = false;
      let textChunks = 0;
      let thoughtChunks = 0;
      let thoughtText = "";
      let settled = false;

      let watchdog: RunWatchdog | null = null;

      const finish = (result: GrokRunResult) => {
        if (settled) return;
        settled = true;
        watchdog?.dispose();
        watchdog = null;
        try {
          fs.unlinkSync(promptFile);
        } catch {
          /* ignore */
        }
        this.child = null;
        resolve(result);
      };

      const emitProgress = (event: GrokProgressEvent): void => {
        if (
          event.stage === "thinking" ||
          event.stage === "writing" ||
          event.stage === "starting" ||
          event.partialText !== undefined
        ) {
          watchdog?.touch();
        }
        req.onProgress(event);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(bin, args, {
          cwd: req.cwd,
          env: { ...process.env },
          windowsHide: true,
          shell: false,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        req.onProgress({
          stage: "error",
          progress: 100,
          message: "无法启动 grok",
          logLine: msg,
          logKind: "error",
        });
        finish({ ok: false, text: "", error: msg, exitCode: null });
        return;
      }

      this.child = child;

      watchdog = new RunWatchdog(
        req.settings.timeoutMs,
        resolveIdleTimeoutMs(req.settings.timeoutMs, req.settings.idleTimeoutMs),
        (_reason, message) => {
          this.terminationError = message;
          emitProgress({
            stage: "error",
            progress: 100,
            message: "超时，已停止 Grok",
            logLine: message,
            logKind: "error",
          });
          this.terminateChild();
        },
      );

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          // Non-JSON line — show as log
          emitProgress({
            stage: "writing",
            progress: null,
            message: "Grok 输出中…",
            logLine: trimmed.slice(0, 500),
            logKind: "meta",
          });
          return;
        }

        const type = String(obj.type ?? "");
        if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
        if (typeof obj.session_id === "string") sessionId = obj.session_id;

        if (type === "thought") {
          thoughtChunks += 1;
          const data = String(obj.data ?? "");
          if (data) thoughtText += (thoughtText ? "\n" : "") + data;
          const prog = Math.min(40, 10 + thoughtChunks * 2);
          emitProgress({
            stage: "thinking",
            progress: prog,
            message: "Grok 正在思考…",
            logLine: data.slice(0, 400),
            logKind: "thought",
            partialThought: thoughtText,
          });
          return;
        }

        if (type === "text") {
          textChunks += 1;
          const data = String(obj.data ?? "");
          finalText += data;
          const prog = Math.min(92, 40 + textChunks * 2);
          emitProgress({
            stage: "writing",
            progress: prog,
            message: "Grok 正在写文档…",
            logLine: data.slice(0, 400),
            logKind: "text",
            partialText: finalText,
          });
          return;
        }

        if (type === "error") {
          const message = String(obj.message ?? "Grok error");
          this.terminationError = message;
          emitProgress({
            stage: "error",
            progress: 100,
            message: "Grok 报错",
            logLine: message,
            logKind: "error",
          });
          this.terminateChild();
          return;
        }

        if (type === "end") {
          sawEnd = true;
          // Prefer end payload text if present
          if (typeof obj.text === "string" && obj.text) {
            finalText = obj.text;
          }
          const turns = obj.num_turns != null ? ` · turns ${obj.num_turns}` : "";
          emitProgress({
            stage: "done",
            progress: 100,
            message: `完成${turns}`,
            logLine: `end stopReason=${String(obj.stopReason ?? "")}`,
            logKind: "meta",
            partialText: finalText,
          });
          return;
        }

        // Other events: max_turns_reached, tool hints, etc.
        emitProgress({
          stage: "writing",
          progress: null,
          message: `事件: ${type || "unknown"}`,
          logLine: trimmed.slice(0, 400),
          logKind: "meta",
        });
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        const parts = stdoutBuf.split(/\r?\n/);
        stdoutBuf = parts.pop() ?? "";
        for (const line of parts) handleLine(line);
      });

      child.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk;
        // Avoid flooding UI; only last line-ish
        const last = chunk.trim().split(/\r?\n/).filter(Boolean).pop();
        if (last) {
          emitProgress({
            stage: this.killed ? "cancelled" : "thinking",
            progress: null,
            message: "Grok 运行中…",
            logLine: last.slice(0, 400),
            logKind: "meta",
          });
        }
      });

      child.on("error", (err) => {
        watchdog?.dispose();
        const msg =
          err.message.includes("ENOENT")
            ? `找不到 grok 可执行文件（${bin}）。请在设置中填写绝对路径，例如 %USERPROFILE%\\.grok\\bin\\grok.exe`
            : err.message;
        req.onProgress({
          stage: "error",
          progress: 100,
          message: "启动失败",
          logLine: msg,
          logKind: "error",
        });
        finish({ ok: false, text: finalText, error: msg, exitCode: null });
      });

      child.on("close", (code) => {
        watchdog?.dispose();
        if (stdoutBuf.trim()) handleLine(stdoutBuf);

        if (this.terminationError) {
          finish({
            ok: false,
            text: finalText,
            error: this.terminationError,
            exitCode: code,
          });
          return;
        }

        if (this.killed) {
          req.onProgress({
            stage: "cancelled",
            progress: 100,
            message: "已取消",
            logLine: "process killed",
            logKind: "meta",
          });
          finish({ ok: false, text: finalText, error: "cancelled", exitCode: code });
          return;
        }

        if (code === 0 && (sawEnd || finalText.trim())) {
          if (!sawEnd) {
            req.onProgress({
              stage: "done",
              progress: 100,
              message: "完成",
              logLine: `exit ${code}`,
              logKind: "meta",
              partialText: finalText,
            });
          }
          finish({ ok: true, text: finalText, sessionId, exitCode: code });
          return;
        }

        const err =
          stderrBuf.trim() ||
          stdoutBuf.trim() ||
          (code === 0 ? "Grok 进程结束，但没有返回回答。" : `grok exited with code ${code}`);
        req.onProgress({
          stage: "error",
          progress: 100,
          message: "Grok 未成功完成",
          logLine: err.slice(0, 800),
          logKind: "error",
        });
        finish({ ok: false, text: finalText, error: err, exitCode: code });
      });
    });
  }
}
