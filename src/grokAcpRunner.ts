import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { Readable, Writable } from "stream";
import type { ContentBlock, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { GrokProgressEvent, GrokRunResult } from "./grokRunner";
import { resolveGrokBinary } from "./grokRunner";
import type { GrokBuildSettings } from "./settings";
import { appendAcpSafetyPrompt, buildAcpProcessArgs } from "./acpArgs";
import { terminateProcessTree } from "./processTree";
import { resolveIdleTimeoutMs, RunWatchdog } from "./runWatchdog";

export { buildAcpProcessArgs, appendAcpSafetyPrompt } from "./acpArgs";

export interface AcpImageInput {
  data: string;
  mimeType: string;
  uri?: string;
}

export interface GrokAcpRunRequest {
  prompt: string;
  images: AcpImageInput[];
  cwd: string;
  settings: GrokBuildSettings;
  /** Try session/resume before opening a new ACP session. */
  resumeSessionId?: string;
  onProgress: (event: GrokProgressEvent) => void;
}

export class GrokAcpRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private killed = false;
  private terminationError: string | null = null;
  private watchdog: RunWatchdog | null = null;

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  cancel(): void {
    this.killed = true;
    this.terminationError = null;
    this.watchdog?.dispose();
    this.watchdog = null;
    this.terminateChild();
  }

  private terminateChild(): void {
    terminateProcessTree(this.child);
  }

  async run(request: GrokAcpRunRequest): Promise<GrokRunResult> {
    this.killed = false;
    this.terminationError = null;
    this.watchdog?.dispose();
    this.watchdog = null;

    const binary = resolveGrokBinary(request.settings).path;
    const args = buildAcpProcessArgs(request.settings);
    const safePrompt = appendAcpSafetyPrompt(request.prompt, request.settings);

    const emitProgress = (event: GrokProgressEvent): void => {
      if (
        event.stage === "thinking" ||
        event.stage === "writing" ||
        event.stage === "starting" ||
        event.partialText !== undefined
      ) {
        this.watchdog?.touch();
      }
      request.onProgress(event);
    };

    emitProgress({
      stage: "starting",
      progress: 5,
      message: "正在连接 Grok 图片会话…",
      logLine: `${binary} ${args.join(" ")}`,
      logKind: "meta",
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, {
        cwd: request.cwd,
        env: { ...process.env },
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.onProgress({
        stage: "error",
        progress: 100,
        message: "无法启动 Grok 图片会话",
        logLine: message,
        logKind: "error",
      });
      return { ok: false, text: "", error: message, exitCode: null };
    }
    this.child = child;

    let stderr = "";
    let rejectProcessFailure: ((reason: Error) => void) | null = null;
    const processFailure = new Promise<never>((_, reject) => {
      rejectProcessFailure = reject;
    });
    child.once("error", (error) => {
      stderr += error.message;
      rejectProcessFailure?.(error);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      // stderr chatter counts as activity (agent is alive)
      this.watchdog?.touch();
    });

    this.watchdog = new RunWatchdog(
      request.settings.timeoutMs,
      resolveIdleTimeoutMs(request.settings.timeoutMs, request.settings.idleTimeoutMs),
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
        rejectProcessFailure?.(new Error(message));
      },
    );

    const run = async (): Promise<GrokRunResult> => {
      const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
      const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(output, input);
      let finalText = "";
      let thoughtText = "";
      let sessionId: string | undefined;

      const chooseSafePermission = (params: RequestPermissionRequest) => {
        const reject =
          params.options.find((option) => option.kind === "reject_once") ??
          params.options.find((option) => option.kind === "reject_always");
        return reject
          ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      };

      const result = await acp
        .client({ name: "grok-obsidian" })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
          chooseSafePermission(ctx.params),
        )
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });

          type Attachable = {
            attachSession: (response: { sessionId: string }) => {
              sessionId: string;
              prompt: (blocks: ContentBlock[]) => Promise<unknown>;
              nextUpdate: () => Promise<
                | { kind: "stop"; response: { stopReason?: string } }
                | { kind: "session_update"; update: Record<string, unknown> }
              >;
            };
          };
          const attachable = ctx as unknown as Attachable;

          const runWithSession = async (session: {
            sessionId: string;
            prompt: (blocks: ContentBlock[]) => Promise<unknown>;
            nextUpdate: () => Promise<
              | { kind: "stop"; response: { stopReason?: string } }
              | { kind: "session_update"; update: Record<string, unknown> }
            >;
          }) => {
            sessionId = session.sessionId;
            const blocks: ContentBlock[] = [
              { type: "text", text: safePrompt },
              ...request.images.map((image) => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType,
                uri: image.uri,
              })),
            ];
            void session.prompt(blocks).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              this.terminationError = message;
              this.terminateChild();
            });

            for (;;) {
              const update = await session.nextUpdate();
              if (update.kind === "stop") {
                return update.response;
              }
              const event = update.update as {
                sessionUpdate?: string;
                content?: { type?: string; text?: string };
              };
              if (event.sessionUpdate === "agent_message_chunk" && event.content?.type === "text") {
                finalText += event.content.text ?? "";
                emitProgress({
                  stage: "writing",
                  progress: null,
                  message: "Grok 正在回复…",
                  logLine: (event.content.text ?? "").slice(0, 400),
                  logKind: "text",
                  partialText: finalText,
                });
              } else if (event.sessionUpdate === "agent_thought_chunk") {
                const chunk =
                  event.content?.type === "text"
                    ? (event.content.text ?? "")
                    : typeof (event as { content?: { text?: string } }).content?.text === "string"
                      ? ((event as { content?: { text?: string } }).content?.text ?? "")
                      : "";
                if (chunk) thoughtText += chunk;
                else if ((event as { content?: unknown }).content) {
                  const raw = (event as { content?: { text?: string } | string }).content;
                  const text =
                    typeof raw === "string"
                      ? raw
                      : typeof raw?.text === "string"
                        ? raw.text
                        : "";
                  if (text) thoughtText += text;
                }
                emitProgress({
                  stage: "thinking",
                  progress: null,
                  message: "Grok 正在理解图片…",
                  logKind: "thought",
                  partialThought: thoughtText || undefined,
                });
              } else if (
                event.sessionUpdate === "tool_call" ||
                event.sessionUpdate === "tool_call_update"
              ) {
                emitProgress({
                  stage: "thinking",
                  progress: null,
                  message: "Grok 正在处理上下文…",
                  logKind: "meta",
                });
              } else {
                this.watchdog?.touch();
              }
            }
          };

          if (request.resumeSessionId) {
            try {
              const resumed = await ctx.request(acp.methods.agent.session.resume, {
                sessionId: request.resumeSessionId,
                cwd: request.cwd,
                mcpServers: [],
              });
              const session = attachable.attachSession({
                sessionId: request.resumeSessionId,
                ...(resumed as object),
              });
              emitProgress({
                stage: "starting",
                progress: 12,
                message: "已恢复图片会话…",
                logKind: "meta",
              });
              return runWithSession(session);
            } catch {
              emitProgress({
                stage: "starting",
                progress: 10,
                message: "会话恢复失败，正在新建图片会话…",
                logKind: "meta",
              });
            }
          }

          return ctx.buildSession(request.cwd).withSession(async (session) =>
            runWithSession(session),
          );
        });

      const cancelled = result.stopReason === "cancelled";
      const noResponse = !finalText.trim();
      return {
        ok: !cancelled && !noResponse,
        text: finalText,
        sessionId,
        exitCode: 0,
        error: cancelled
          ? "cancelled"
          : noResponse
            ? `Grok 会话结束但没有返回回答（${result.stopReason ?? "未知原因"}）。`
            : undefined,
      };
    };

    try {
      return await Promise.race([run(), processFailure]);
    } catch (error) {
      const message =
        this.terminationError ??
        (this.killed
          ? "cancelled"
          : error instanceof Error
            ? error.message
            : String(error));
      request.onProgress({
        stage: this.killed ? "cancelled" : "error",
        progress: 100,
        message: this.killed ? "已取消" : "图片会话失败",
        logLine: stderr.trim() || message,
        logKind: "error",
      });
      return { ok: false, text: "", error: stderr.trim() || message, exitCode: null };
    } finally {
      this.watchdog?.dispose();
      this.watchdog = null;
      this.terminateChild();
      this.child = null;
    }
  }
}
