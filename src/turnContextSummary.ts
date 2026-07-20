import {
  parseContextSelection,
  type ParsedContextSelection,
} from "./contextParse";

/** Shared vault-context caps used by the plugin and UI summary. */
export const CONTEXT_LIMITS = {
  maxFilesInMessage: 8,
  maxFoldersInMessage: 4,
  maxTagsInMessage: 6,
  maxExpandedPaths: 32,
  maxFilesPerFolder: 20,
  maxFilesPerTag: 20,
  maxCharsPerFile: 50_000,
  maxCharsTotal: 180_000,
} as const;

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
  const selection = parseContextSelection(input.draftMessage, {
    files: CONTEXT_LIMITS.maxFilesInMessage,
    folders: CONTEXT_LIMITS.maxFoldersInMessage,
    tags: CONTEXT_LIMITS.maxTagsInMessage,
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
    input.expandedPathCount >= CONTEXT_LIMITS.maxExpandedPaths;

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
  if (input.expandedPathCount > 0) {
    parts.push(`展开 ${input.expandedPathCount}/${CONTEXT_LIMITS.maxExpandedPaths}`);
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
export function estimateExpansionCap(selection: ParsedContextSelection, folderHits: number[], tagHits: number[]): {
  expandedPathCount: number;
  expansionCapped: boolean;
} {
  let count = selection.filePaths.length;
  let capped = false;

  for (const hits of folderHits) {
    const taken = Math.min(hits, CONTEXT_LIMITS.maxFilesPerFolder);
    if (hits > CONTEXT_LIMITS.maxFilesPerFolder) capped = true;
    count += taken;
  }
  for (const hits of tagHits) {
    const taken = Math.min(hits, CONTEXT_LIMITS.maxFilesPerTag);
    if (hits > CONTEXT_LIMITS.maxFilesPerTag) capped = true;
    count += taken;
  }

  if (count > CONTEXT_LIMITS.maxExpandedPaths) {
    capped = true;
    count = CONTEXT_LIMITS.maxExpandedPaths;
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
