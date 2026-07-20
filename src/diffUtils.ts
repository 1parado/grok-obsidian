export type ChangeKind = "full" | "partial" | "create";

export interface SearchReplace {
  search: string;
  replace: string;
}

export interface ProposedChange {
  /** Vault-relative path using forward slashes. */
  path: string;
  kind: ChangeKind;
  /** Full file body for full/create. */
  content?: string;
  /** Partial edits applied in order. */
  replacements?: SearchReplace[];
}

export interface ResolvedChange {
  change: ProposedChange;
  exists: boolean;
  before: string;
  after: string;
  stats: { added: number; removed: number };
  error?: string;
  selected: boolean;
}

/**
 * Extract the best full-document candidate from an assistant response.
 * Prefer a single fenced markdown block when the whole reply is that block;
 * otherwise prefer the largest fenced markdown block, then raw text.
 */
export function extractCandidate(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const whole = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (whole?.[1] != null) return whole[1].trim();

  const blocks = Array.from(
    trimmed.matchAll(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```/gi),
    (match) => match[1]?.trim() ?? "",
  ).filter(Boolean);

  if (blocks.length === 1) return blocks[0];
  if (blocks.length > 1) {
    return blocks.reduce((best, current) =>
      current.length > best.length ? current : best,
    );
  }

  return trimmed;
}

/** Normalize a model-provided path into a vault-relative forward-slash path. */
export function normalizeVaultPath(raw: string): string {
  let path = raw.trim();
  path = path.replace(/^["'`]+|["'`]+$/g, "");
  const wiki = path.match(/^\[\[([^\]]+)\]\]$/);
  if (wiki) path = wiki[1];
  // Wiki link alias: path|alias → path
  path = path.split("|")[0] ?? path;
  path = path.replace(/\\/g, "/");
  path = path.replace(/^\.?\//, "");
  path = path.replace(/^\/+/, "");
  return path.trim();
}

function looksLikePath(value: string): boolean {
  const path = normalizeVaultPath(value);
  if (!path || path.length > 260) return false;
  if (/\s{2,}/.test(path)) return false;
  if (/[\n\r<>|*?]/.test(path)) return false;
  // Prefer paths with an extension or a slash (folder/file).
  return /\.[a-z0-9]{1,8}$/i.test(path) || path.includes("/");
}

function parsePathFromFenceInfo(info: string): string | null {
  const trimmed = info.trim();
  if (!trimmed) return null;

  // ```md:path/to/file.md  |  ```file:path  |  ```path/to/file.md
  const filePrefix = trimmed.match(/^(?:file|path)\s*:\s*(.+)$/i);
  if (filePrefix && looksLikePath(filePrefix[1])) return normalizeVaultPath(filePrefix[1]);

  const colon = trimmed.match(/^(?:md|markdown|text|txt|json|yaml|yml|ts|js|css|html|py)\s*[:\s]\s*(.+)$/i);
  if (colon && looksLikePath(colon[1])) return normalizeVaultPath(colon[1]);

  // Bare path as fence language: ```Notes/a.md
  if (looksLikePath(trimmed) && !/^(md|markdown|text|txt|json|yaml|yml|ts|tsx|js|jsx|css|html|xml|py|sh|bash|shell|diff|patch)$/i.test(trimmed)) {
    return normalizeVaultPath(trimmed);
  }
  return null;
}

function parsePathFromHeading(line: string): string | null {
  const cleaned = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^`+|`+$/g, "")
    .trim();

  const labeled = cleaned.match(
    /^(?:file|path|笔记|文件|修改|更新|新建|create|update|edit)\s*[:：]\s*(.+)$/i,
  );
  if (labeled && looksLikePath(labeled[1])) return normalizeVaultPath(labeled[1]);

  const wiki = cleaned.match(/^\[\[([^\]]+)\]\]$/);
  if (wiki && looksLikePath(wiki[1])) return normalizeVaultPath(wiki[1]);

  if (looksLikePath(cleaned)) return normalizeVaultPath(cleaned);
  return null;
}

function mergeChange(
  map: Map<string, ProposedChange>,
  path: string,
  patch: Partial<ProposedChange> & { kind: ChangeKind },
): void {
  const existing = map.get(path);
  if (!existing) {
    map.set(path, { path, ...patch });
    return;
  }
  if (patch.kind === "full" || patch.kind === "create") {
    map.set(path, {
      path,
      kind: patch.kind,
      content: patch.content,
      replacements: undefined,
    });
    return;
  }
  if (patch.replacements?.length) {
    const replacements = [...(existing.replacements ?? []), ...patch.replacements];
    // Full content wins over partial if both appear; otherwise accumulate partials.
    if (existing.kind === "full" || existing.kind === "create") {
      map.set(path, existing);
      return;
    }
    map.set(path, { path, kind: "partial", replacements });
  }
}

/**
 * Parse multi-file full replacements and partial SEARCH/REPLACE blocks from a model reply.
 * When nothing path-scoped is found, falls back to a single full change for `fallbackPath`.
 */
export function parseProposedChanges(
  text: string,
  options: { fallbackPath?: string } = {},
): ProposedChange[] {
  const map = new Map<string, ProposedChange>();
  const source = text.replace(/\r\n/g, "\n");

  // 1) Fenced blocks with path in info string.
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let fenceMatch: RegExpExecArray | null;
  const fencedRanges: Array<{ start: number; end: number }> = [];
  while ((fenceMatch = fenceRe.exec(source)) !== null) {
    const info = fenceMatch[1] ?? "";
    const body = (fenceMatch[2] ?? "").replace(/\n$/, "");
    const path = parsePathFromFenceInfo(info);
    fencedRanges.push({ start: fenceMatch.index, end: fenceMatch.index + fenceMatch[0].length });
    if (!path || !body.trim()) continue;
    mergeChange(map, path, { kind: "full", content: body });
  }

  // 2) Heading / label line immediately before a generic fenced block.
  const headingFenceRe =
    /(?:^|\n)((?:#{1,6}\s+|[ \t]*(?:\*\*)?(?:file|path|笔记|文件)\s*[:：]\s*)[^\n]+)\n+```[^\n]*\n([\s\S]*?)```/gi;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingFenceRe.exec(source)) !== null) {
    const path = parsePathFromHeading(headingMatch[1].trim());
    const body = (headingMatch[2] ?? "").replace(/\n$/, "");
    if (!path || !body.trim()) continue;
    // Skip if this body was already captured with an explicit fence path.
    const already = [...map.values()].some((item) => item.content === body && item.path === path);
    if (already) continue;
    mergeChange(map, path, { kind: "full", content: body });
  }

  // 3) SEARCH / REPLACE partial blocks (optionally preceded by a path line).
  const srRe =
    /(?:(?:^|\n)((?:#{1,6}\s+|[ \t]*(?:\*\*)?(?:file|path|笔记|文件)\s*[:：]\s*|[ \t]*)[^\n]*?)\n+)?<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  let srMatch: RegExpExecArray | null;
  let lastSrPath: string | null = null;
  while ((srMatch = srRe.exec(source)) !== null) {
    const header = (srMatch[1] ?? "").trim();
    const search = srMatch[2] ?? "";
    const replace = srMatch[3] ?? "";
    let path = header ? parsePathFromHeading(header) : null;
    if (!path && header && looksLikePath(header)) path = normalizeVaultPath(header);
    if (path) lastSrPath = path;
    else path = lastSrPath;
    if (!path) continue;
    mergeChange(map, path, {
      kind: "partial",
      replacements: [{ search, replace }],
    });
  }

  // 4) Fallback: single full document for the active note.
  if (map.size === 0 && options.fallbackPath) {
    const candidate = extractCandidate(source);
    if (candidate.trim()) {
      map.set(options.fallbackPath, {
        path: options.fallbackPath,
        kind: "full",
        content: candidate,
      });
    }
  }

  return Array.from(map.values());
}

/** Apply ordered search/replace patches. Each search must match exactly once. */
export function applyReplacements(
  content: string,
  replacements: SearchReplace[],
): { ok: true; content: string } | { ok: false; error: string } {
  let next = content;
  for (const [index, item] of replacements.entries()) {
    if (!item.search) {
      return { ok: false, error: `第 ${index + 1} 处 SEARCH 为空` };
    }
    const occurrences = next.split(item.search).length - 1;
    if (occurrences === 0) {
      return {
        ok: false,
        error: `第 ${index + 1} 处 SEARCH 未在文件中找到唯一匹配`,
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        error: `第 ${index + 1} 处 SEARCH 匹配了 ${occurrences} 次，已拒绝（需唯一）`,
      };
    }
    next = next.replace(item.search, item.replace);
  }
  return { ok: true, content: next };
}

/** Compute the resulting file body for a proposed change. */
export function materializeChange(
  before: string,
  change: ProposedChange,
  exists: boolean,
): { ok: true; after: string; kind: ChangeKind } | { ok: false; error: string } {
  if (change.kind === "partial") {
    if (!exists) {
      return { ok: false, error: "局部修改的目标文件不存在" };
    }
    const applied = applyReplacements(before, change.replacements ?? []);
    if (!applied.ok) return applied;
    return { ok: true, after: applied.content, kind: "partial" };
  }

  if (change.content == null) {
    return { ok: false, error: "缺少文件内容" };
  }
  return {
    ok: true,
    after: change.content,
    kind: exists ? "full" : "create",
  };
}

/** Line-oriented prefix/suffix diff with a few context lines. */
export function buildSimpleDiff(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  const lines: string[] = [];
  if (contextStart > 0) lines.push("  …");
  for (const line of oldLines.slice(contextStart, prefix)) lines.push(`  ${line}`);
  for (const line of oldLines.slice(prefix, oldEnd)) lines.push(`- ${line}`);
  for (const line of newLines.slice(prefix, newEnd)) lines.push(`+ ${line}`);
  for (const line of newLines.slice(newEnd, Math.min(newLines.length, newEnd + 3))) {
    lines.push(`  ${line}`);
  }
  if (newEnd + 3 < newLines.length) lines.push("  …");
  return lines.join("\n") || "  没有变化";
}

export function countDiffStats(before: string, after: string): { added: number; removed: number } {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    removed: Math.max(0, oldLines.length - prefix - suffix),
    added: Math.max(0, newLines.length - prefix - suffix),
  };
}

export function kindLabel(kind: ChangeKind, exists: boolean): string {
  if (kind === "partial") return "局部修改";
  if (!exists || kind === "create") return "新建文件";
  return "全文替换";
}
