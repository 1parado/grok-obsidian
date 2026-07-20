import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "grok-obsidian-test-"));

await build({
  entryPoints: [
    path.join(root, "src/diffUtils.ts"),
    path.join(root, "src/contextParse.ts"),
    path.join(root, "src/acpArgs.ts"),
    path.join(root, "src/activeNoteResolve.ts"),
    path.join(root, "src/turnContextSummary.ts"),
    path.join(root, "src/suggestionRank.ts"),
    path.join(root, "src/historyInjection.ts"),
    path.join(root, "src/processTree.ts"),
    path.join(root, "src/runWatchdog.ts"),
  ],
  outdir: outDir,
  format: "esm",
  platform: "node",
  bundle: true,
  packages: "external",
});

const {
  extractCandidate,
  buildSimpleDiff,
  countDiffStats,
  parseProposedChanges,
  applyReplacements,
  materializeChange,
  normalizeVaultPath,
} = await import(pathToFileURL(path.join(outDir, "diffUtils.js")).href);
const { parseContextSelection, tagMatches } = await import(
  pathToFileURL(path.join(outDir, "contextParse.js")).href
);
const { buildAcpProcessArgs } = await import(
  pathToFileURL(path.join(outDir, "acpArgs.js")).href
);
const { resolveActiveNotePath, activeNoteChipLabel } = await import(
  pathToFileURL(path.join(outDir, "activeNoteResolve.js")).href
);
const { summarizeTurnContext, estimateExpansionCap, CONTEXT_LIMITS } = await import(
  pathToFileURL(path.join(outDir, "turnContextSummary.js")).href
);
const { rankAtSuggestions, matchScore } = await import(
  pathToFileURL(path.join(outDir, "suggestionRank.js")).href
);
const { shouldInjectLocalHistory } = await import(
  pathToFileURL(path.join(outDir, "historyInjection.js")).href
);
const { windowsTaskkillArgs } = await import(
  pathToFileURL(path.join(outDir, "processTree.js")).href
);
const { resolveIdleTimeoutMs, RunWatchdog } = await import(
  pathToFileURL(path.join(outDir, "runWatchdog.js")).href
);

test("extractCandidate prefers whole-message fenced markdown", () => {
  const text = "```md\n# Title\nbody\n```";
  assert.equal(extractCandidate(text), "# Title\nbody");
});

test("extractCandidate picks largest fenced block when mixed prose", () => {
  const text = [
    "Here is the edit:",
    "```markdown",
    "line1",
    "line2",
    "line3",
    "```",
    "Also a tiny one:",
    "```md",
    "x",
    "```",
  ].join("\n");
  assert.equal(extractCandidate(text), "line1\nline2\nline3");
});

test("extractCandidate falls back to raw text", () => {
  assert.equal(extractCandidate("plain note"), "plain note");
});

test("buildSimpleDiff highlights changed middle", () => {
  const diff = buildSimpleDiff("a\nb\nc", "a\nB\nc");
  assert.match(diff, /^- b$/m);
  assert.match(diff, /^\+ B$/m);
});

test("countDiffStats counts added and removed lines", () => {
  const stats = countDiffStats("a\nb\nc", "a\nx\ny\nc");
  assert.equal(stats.removed, 1);
  assert.equal(stats.added, 2);
});

test("normalizeVaultPath cleans wiki links and slashes", () => {
  assert.equal(normalizeVaultPath("[[Notes/A.md|Alias]]"), "Notes/A.md");
  assert.equal(normalizeVaultPath(".\\Notes\\B.md"), "Notes/B.md");
});

test("parseProposedChanges reads multi-file fenced paths", () => {
  const text = [
    "Updates:",
    "```md:Notes/a.md",
    "# A",
    "```",
    "```md:Notes/b.md",
    "# B",
    "```",
  ].join("\n");
  const changes = parseProposedChanges(text);
  assert.equal(changes.length, 2);
  assert.deepEqual(
    changes.map((c) => c.path).sort(),
    ["Notes/a.md", "Notes/b.md"],
  );
  assert.equal(changes.find((c) => c.path === "Notes/a.md")?.content, "# A");
});

test("parseProposedChanges reads heading + fence full files", () => {
  const text = ["### Projects/plan.md", "```md", "todo", "```"].join("\n");
  const changes = parseProposedChanges(text);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "Projects/plan.md");
  assert.equal(changes[0].kind, "full");
  assert.equal(changes[0].content, "todo");
});

test("parseProposedChanges reads SEARCH/REPLACE partials", () => {
  const text = [
    "### Notes/a.md",
    "<<<<<<< SEARCH",
    "old",
    "=======",
    "new",
    ">>>>>>> REPLACE",
  ].join("\n");
  const changes = parseProposedChanges(text);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "partial");
  assert.deepEqual(changes[0].replacements, [{ search: "old", replace: "new" }]);
});

test("parseProposedChanges falls back to active note full content", () => {
  const changes = parseProposedChanges("```md\n# only\n```", {
    fallbackPath: "Inbox/note.md",
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "Inbox/note.md");
  assert.equal(changes[0].content, "# only");
});

test("applyReplacements requires unique match", () => {
  const ok = applyReplacements("a\nb\nc", [{ search: "b", replace: "B" }]);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.content, "a\nB\nc");

  const missing = applyReplacements("a", [{ search: "z", replace: "Z" }]);
  assert.equal(missing.ok, false);

  const multi = applyReplacements("x x", [{ search: "x", replace: "y" }]);
  assert.equal(multi.ok, false);
});

test("materializeChange creates full file and applies partial", () => {
  const created = materializeChange("", { path: "n.md", kind: "full", content: "hi" }, false);
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.kind, "create");
    assert.equal(created.after, "hi");
  }

  const partial = materializeChange(
    "hello world",
    {
      path: "n.md",
      kind: "partial",
      replacements: [{ search: "world", replace: "vault" }],
    },
    true,
  );
  assert.equal(partial.ok, true);
  if (partial.ok) assert.equal(partial.after, "hello vault");
});

test("parseContextSelection extracts files folders tags", () => {
  const parsed = parseContextSelection(
    "see @[[Notes/A.md]] and @{Projects} #work/todo more #work",
  );
  assert.deepEqual(parsed.filePaths, ["Notes/A.md"]);
  assert.deepEqual(parsed.folderPaths, ["Projects"]);
  assert.deepEqual(parsed.tags, ["work/todo", "work"]);
});

test("parseContextSelection respects limits and dedupes", () => {
  const parsed = parseContextSelection(
    "@[[a.md]] @[[a.md]] @[[b.md]] @{f1} @{f1} #t1 #t1",
    { files: 1, folders: 1, tags: 1 },
  );
  assert.deepEqual(parsed.filePaths, ["a.md"]);
  assert.deepEqual(parsed.folderPaths, ["f1"]);
  assert.deepEqual(parsed.tags, ["t1"]);
});

test("tagMatches supports hierarchical tags", () => {
  assert.equal(tagMatches("work/todo", "work"), true);
  assert.equal(tagMatches("work", "work/todo"), true);
  assert.equal(tagMatches("work", "work"), true);
  assert.equal(tagMatches("play", "work"), false);
});

test("buildAcpProcessArgs applies plan rules and tools without model override", () => {
  const args = buildAcpProcessArgs({
    grokPath: "",
    timeoutMs: 1000,
    idleTimeoutMs: 120000,
    maxTurns: 12,
    disallowedTools: "run_terminal_cmd",
    extraRules: "be careful",
    includeActiveNoteByDefault: true,
    historyLimit: 20,
    deleteAttachmentsOnCleanup: true,
    customPrompts: [],
  });
  assert.deepEqual(args.slice(0, 4), ["--permission-mode", "plan", "--max-turns", "12"]);
  assert.ok(args.includes("--disallowed-tools"));
  assert.ok(args.includes("run_terminal_cmd"));
  assert.ok(args.includes("--rules"));
  assert.ok(args.includes("be careful"));
  assert.equal(args.includes("-m"), false);
  assert.deepEqual(args.slice(-2), ["agent", "stdio"]);
});

test("resolveActiveNotePath prefers current Markdown then last-focused", () => {
  assert.equal(
    resolveActiveNotePath({
      includeActiveNote: true,
      currentMarkdownPath: "Notes/now.md",
      lastMarkdownPath: "Notes/old.md",
    }),
    "Notes/now.md",
  );
  assert.equal(
    resolveActiveNotePath({
      includeActiveNote: true,
      currentMarkdownPath: null,
      lastMarkdownPath: "Notes/old.md",
    }),
    "Notes/old.md",
  );
  assert.equal(
    resolveActiveNotePath({
      includeActiveNote: false,
      currentMarkdownPath: "Notes/now.md",
      lastMarkdownPath: "Notes/old.md",
    }),
    null,
  );
  assert.equal(
    resolveActiveNotePath({
      includeActiveNote: true,
      currentMarkdownPath: null,
      lastMarkdownPath: null,
    }),
    null,
  );
});

test("activeNoteChipLabel shows basename or none", () => {
  assert.equal(activeNoteChipLabel("Folder/周报.md"), "周报");
  assert.equal(activeNoteChipLabel(null), "无笔记");
  assert.equal(activeNoteChipLabel(""), "无笔记");
});

test("summarizeTurnContext reports active note drafts and truncation", () => {
  const summary = summarizeTurnContext({
    includeActiveNote: true,
    activeNotePath: "Notes/a.md",
    draftMessage: "@[[b.md]] @{Projects} #work",
    attachmentCount: 1,
    expandedPathCount: 32,
    expansionCapped: true,
  });
  assert.equal(summary.fileCount, 1);
  assert.equal(summary.folderCount, 1);
  assert.equal(summary.tagCount, 1);
  assert.equal(summary.attachmentCount, 1);
  assert.equal(summary.truncated, true);
  assert.match(summary.line, /笔记·a/);
  assert.match(summary.line, /已截断/);
});

test("summarizeTurnContext none active note when toggle on but path missing", () => {
  const summary = summarizeTurnContext({
    includeActiveNote: true,
    activeNotePath: null,
    draftMessage: "",
    attachmentCount: 0,
    expandedPathCount: 0,
    expansionCapped: false,
  });
  assert.match(summary.line, /笔记·无/);
  assert.equal(summary.truncated, false);
});

test("estimateExpansionCap enforces path and folder limits", () => {
  const selection = parseContextSelection("@[[a.md]] @{f}");
  const result = estimateExpansionCap(selection, [25], []);
  assert.equal(result.expansionCapped, true);
  assert.ok(result.expandedPathCount <= CONTEXT_LIMITS.maxExpandedPaths);
});

test("rankAtSuggestions prefers recent files for empty query", () => {
  const ranked = rankAtSuggestions(
    [
      { kind: "file", key: "old.md", title: "old.md", subtitle: "", mtime: 1 },
      { kind: "file", key: "new.md", title: "new.md", subtitle: "", mtime: 99 },
      { kind: "folder", key: "Z", title: "Z", subtitle: "Z" },
    ],
    "",
    { limit: 10, recentBiasMaxQueryLen: 1 },
  );
  assert.equal(ranked[0].key, "new.md");
  assert.equal(matchScore("alpha.md", "root", "alp"), 0);
  assert.equal(matchScore("beta.md", "root", "zzz"), 99);
});

test("shouldInjectLocalHistory covers image missing session and post-ACP text", () => {
  assert.equal(
    shouldInjectLocalHistory({
      hasImageAttachments: true,
      hasSessionId: true,
      lastTurnUsedAcp: false,
    }),
    true,
  );
  assert.equal(
    shouldInjectLocalHistory({
      hasImageAttachments: false,
      hasSessionId: false,
      lastTurnUsedAcp: false,
    }),
    true,
  );
  assert.equal(
    shouldInjectLocalHistory({
      hasImageAttachments: false,
      hasSessionId: true,
      lastTurnUsedAcp: true,
    }),
    true,
  );
  assert.equal(
    shouldInjectLocalHistory({
      hasImageAttachments: false,
      hasSessionId: true,
      lastTurnUsedAcp: false,
    }),
    false,
  );
});

test("windowsTaskkillArgs builds process-tree kill command", () => {
  assert.deepEqual(windowsTaskkillArgs(12345), ["/pid", "12345", "/T", "/F"]);
});

test("resolveIdleTimeoutMs caps idle by total and floors at 5s", () => {
  assert.equal(resolveIdleTimeoutMs(600_000, 120_000), 120_000);
  assert.equal(resolveIdleTimeoutMs(30_000, 120_000), 30_000);
  assert.equal(resolveIdleTimeoutMs(60_000, 1_000), 5_000);
});

test("RunWatchdog fires idle timeout and touch resets it", async () => {
  let fired = "";
  const dog = new RunWatchdog(60_000, 40, (_reason, message) => {
    fired = message;
  });
  dog.touch();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, "");
  dog.touch();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, "");
  await new Promise((r) => setTimeout(r, 50));
  assert.match(fired, /无进度/);
  dog.dispose();
});

test("source wiring: last-markdown tracking, history confirm, diff open, history inject", () => {
  const main = readFileSync(path.join(root, "src/main.ts"), "utf8");
  const historyModal = readFileSync(path.join(root, "src/historyModal.ts"), "utf8");
  const diffModal = readFileSync(path.join(root, "src/diffModal.ts"), "utf8");
  const petView = readFileSync(path.join(root, "src/petView.ts"), "utf8");
  const acp = readFileSync(path.join(root, "src/grokAcpRunner.ts"), "utf8");
  const headless = readFileSync(path.join(root, "src/grokRunner.ts"), "utf8");

  assert.match(main, /active-leaf-change/);
  assert.match(main, /lastMarkdownPath/);
  assert.match(main, /resolveActiveNotePath/);
  assert.match(main, /shouldInjectLocalHistory/);
  assert.match(main, /lastTurnUsedAcp/);
  assert.match(main, /setTurnContextSummary/);
  assert.match(main, /activeNoteChipLabel/);

  assert.match(historyModal, /window\.confirm/);
  assert.match(diffModal, /openFile\(firstFile\)/);
  assert.match(petView, /grok-pet-turn-summary/);
  assert.match(petView, /ensureAtIndex|rankAtSuggestions/);
  assert.match(petView, /invalidateSuggestionIndex/);

  assert.match(acp, /terminateProcessTree/);
  assert.match(acp, /RunWatchdog/);
  assert.match(headless, /terminateProcessTree/);
  assert.match(headless, /RunWatchdog/);
});

test.after(() => {
  rmSync(outDir, { recursive: true, force: true });
});
