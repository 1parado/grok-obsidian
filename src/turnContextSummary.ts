import {
  parseContextSelection,
  type ParsedContextSelection,
} from "./contextParse";
import {
  DEFAULT_CONTEXT_LIMITS,
  mergeContextLimits,
  type ContextLimits,
} from "./contextLimits";

/** @deprecated Prefer mergeContextLimits / DEFAULT_CONTEXT_LIMITS from contextLimits. */
export const CONTEXT_LIMITS = DEFAULT_CONTEXT_LIMITS;

export type { ContextLimits };
export { DEFAULT_CONTEXT_LIMITS, mergeContextLimits } from "./contextLimits";

export interface TurnContextSummaryInput {
  includeActiveNote: boolean;
  activeNotePath: string | null;
  draftMessage: string;
  attachmentCount: number;
  /** Expanded vault paths that would be read (after folder/tag expansion, before char read). */
  expandedPathCount: number;
  /** True if folder/tag expansion was cut by maxExpandedPaths or per-folder/tag caps. */
  expansionCapped: boolean;
  /** True if file body content was cut by per-file or total char limits (set after read when known). */
  contentTruncated?: boolean;
  /** Optional selection character count for summary line. */
  selectionChars?: number;
  limits?: Partial<ContextLimits>;
}

export interface TurnContextSummary {
  activeNoteLabel: string | null;
  fileCount: number;
  folderCount: number;
  tagCount: number;
  attachmentCount: number;
  expandedPathCount: number;
  truncated: boolean;
  /** Short Chinese line for the context rail. */
  line: string;
}

export function summarizeTurnContext(input: TurnContextSummaryInput): TurnContextSummary {
  const limits = mergeContextLimits(input.limits);
  const selection = parseContextSelection(input.draftMessage, {
    files: limits.maxFilesInMessage,
    folders: limits.maxFoldersInMessage,
    tags: limits.maxTagsInMessage,
  });

  const rawFiles = countRawMentions(input.draftMessage, /@\[\[([^\]]+)\]\]/g);
  const rawFolders = countRawMentions(input.draftMessage, /@\{([^}]+)\}/g);
  const rawTags = countRawMentions(input.draftMessage, /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu);

  const mentionCapped =
    rawFiles > selection.filePaths.length ||
    rawFolders > selection.folderPaths.length ||
    rawTags > selection.tags.length;

  const truncated =
    Boolean(input.expansionCapped) ||
    Boolean(input.contentTruncated) ||
    mentionCapped ||
    input.expandedPathCount >= limits.maxExpandedPaths;

  const activeNoteLabel =
    input.includeActiveNote && input.activeNotePath
      ? basename(input.activeNotePath)
      : input.includeActiveNote
        ? null
        : undefined;

  const parts: string[] = [];
  if (input.includeActiveNote) {
    parts.push(activeNoteLabel ? `笔记·${activeNoteLabel}` : "笔记·无");
  }
  if (selection.filePaths.length) parts.push(`文件 ${selection.filePaths.length}`);
  if (selection.folderPaths.length) parts.push(`文件夹 ${selection.folderPaths.length}`);
  if (selection.tags.length) parts.push(`标签 ${selection.tags.length}`);
  if (input.attachmentCount > 0) parts.push(`图 ${input.attachmentCount}`);
  if (input.selectionChars && input.selectionChars > 0) {
    parts.push(`选区 ${input.selectionChars}`);
  }
  if (input.expandedPathCount > 0) {
    parts.push(`展开 ${input.expandedPathCount}/${limits.maxExpandedPaths}`);
  }
  if (truncated) parts.push("已截断");

  return {
    activeNoteLabel: activeNoteLabel ?? null,
    fileCount: selection.filePaths.length,
    folderCount: selection.folderPaths.length,
    tagCount: selection.tags.length,
    attachmentCount: input.attachmentCount,
    expandedPathCount: input.expandedPathCount,
    truncated,
    line: parts.length ? parts.join(" · ") : "本轮无额外上下文",
  };
}

/** Pure estimate of expansion caps without vault I/O. */
export function estimateExpansionCap(
  selection: ParsedContextSelection,
  folderHits: number[],
  tagHits: number[],
  limitsInput?: Partial<ContextLimits>,
): {
  expandedPathCount: number;
  expansionCapped: boolean;
} {
  const limits = mergeContextLimits(limitsInput);
  let count = selection.filePaths.length;
  let capped = false;

  for (const hits of folderHits) {
    const taken = Math.min(hits, limits.maxFilesPerFolder);
    if (hits > limits.maxFilesPerFolder) capped = true;
    count += taken;
  }
  for (const hits of tagHits) {
    const taken = Math.min(hits, limits.maxFilesPerTag);
    if (hits > limits.maxFilesPerTag) capped = true;
    count += taken;
  }

  if (count > limits.maxExpandedPaths) {
    capped = true;
    count = limits.maxExpandedPaths;
  }

  return { expandedPathCount: count, expansionCapped: capped };
}

function basename(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "") || name;
}

function countRawMentions(message: string, pattern: RegExp): number {
  return Array.from(message.matchAll(pattern)).length;
}
