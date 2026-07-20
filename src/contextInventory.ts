import { parseContextSelection } from "./contextParse";
import { DEFAULT_CONTEXT_LIMITS, type ContextLimits, mergeContextLimits } from "./contextLimits";

export type InventoryItemKind =
  | "active-note"
  | "open-tab"
  | "file"
  | "folder"
  | "tag"
  | "selection"
  | "image"
  | "expanded";

export interface ContextInventoryItem {
  kind: InventoryItemKind;
  path: string;
  label: string;
  token?: string;
  /** True when this entry may be incomplete (capped expansion or truncated body). */
  truncated?: boolean;
  /** Extra detail for UI (e.g. "前 20 个文件"). */
  detail?: string;
  removable?: boolean;
}

export interface BuildInventoryInput {
  includeActiveNote: boolean;
  activeNotePath: string | null;
  openTabPaths?: string[];
  draftMessage: string;
  attachmentCount: number;
  /** Paths that would actually be read after expansion (may be capped). */
  expandedPaths?: string[];
  expansionCapped?: boolean;
  contentTruncated?: boolean;
  selectionChars?: number;
  limits?: Partial<ContextLimits>;
}

export interface ContextInventory {
  items: ContextInventoryItem[];
  truncated: boolean;
  line: string;
  truncationReasons: string[];
}

export function buildContextInventory(input: BuildInventoryInput): ContextInventory {
  const limits = mergeContextLimits(input.limits ?? DEFAULT_CONTEXT_LIMITS);
  const selection = parseContextSelection(input.draftMessage, {
    files: limits.maxFilesInMessage,
    folders: limits.maxFoldersInMessage,
    tags: limits.maxTagsInMessage,
  });
  const rawFiles = countRawMentions(input.draftMessage, /@\[\[([^\]]+)\]\]/g);
  const rawFolders = countRawMentions(input.draftMessage, /@\{([^}]+)\}/g);
  const rawTags = countRawMentions(input.draftMessage, /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu);

  const items: ContextInventoryItem[] = [];
  let truncated = Boolean(input.expansionCapped) || Boolean(input.contentTruncated);
  const truncationReasons: string[] = [];

  if (input.includeActiveNote) {
    if (input.activeNotePath) {
      items.push({
        kind: "active-note",
        path: input.activeNotePath,
        label: basename(input.activeNotePath),
        detail: "活动笔记",
        token: input.activeNotePath,
        removable: true,
      });
    } else {
      items.push({
        kind: "active-note",
        path: "",
        label: "（无活动笔记）",
        detail: "已开启但未记录路径",
        truncated: true,
      });
      truncated = true;
      truncationReasons.push("当前已开启活动笔记，但未记录可发送的笔记路径");
    }
  }

  for (const path of input.openTabPaths ?? []) {
    if (path && path !== input.activeNotePath) {
      items.push({
        kind: "open-tab",
        path,
        label: basename(path),
        detail: "打开标签",
        token: path,
        removable: true,
      });
    }
  }

  if (input.selectionChars && input.selectionChars > 0) {
    items.push({
      kind: "selection",
      path: input.activeNotePath ?? "",
      label: `选区 · ${input.selectionChars} 字`,
      detail: "编辑器选中文本",
      token: "__selection__",
      removable: false,
    });
  }

  for (const path of selection.filePaths) {
    items.push({
      kind: "file",
      path,
      label: basename(path),
      detail: "提及文件",
      token: `@[[${path}]]`,
      removable: true,
    });
  }
  for (const path of selection.folderPaths) {
    items.push({
      kind: "folder",
      path,
      label: path.split("/").pop() ?? path,
      detail: `文件夹（最多 ${limits.maxFilesPerFolder} 个文件）`,
      truncated: input.expansionCapped,
      token: `@{${path}}`,
      removable: true,
    });
  }
  for (const tag of selection.tags) {
    items.push({
      kind: "tag",
      path: `#${tag}`,
      label: `#${tag}`,
      detail: `标签（最多 ${limits.maxFilesPerTag} 个文件）`,
      truncated: input.expansionCapped,
      token: `#${tag}`,
      removable: true,
    });
  }

  if (input.attachmentCount > 0) {
    items.push({
      kind: "image",
      path: "",
      label: `图片 × ${input.attachmentCount}`,
      detail: "待发送附件",
      token: "__attachments__",
      removable: true,
    });
  }

  const expanded = input.expandedPaths ?? [];
  if (expanded.length > 0) {
    const shown = expanded.slice(0, limits.maxExpandedPaths);
    if (expanded.length > limits.maxExpandedPaths || input.expansionCapped) {
      truncated = true;
      if (input.expansionCapped) {
        truncationReasons.push(
          `展开路径达到上限：最多 ${limits.maxExpandedPaths} 条，文件夹最多 ${limits.maxFilesPerFolder} 个文件，标签最多 ${limits.maxFilesPerTag} 个文件`,
        );
      }
    }
    items.push({
      kind: "expanded",
      path: "",
      label: `展开路径 ${shown.length}/${limits.maxExpandedPaths}`,
      detail: input.contentTruncated ? "部分正文将被截断" : "将读入的 Vault 路径",
      truncated,
    });
  }

  const selectionLimitsHit =
    rawFiles > selection.filePaths.length ||
    rawFolders > selection.folderPaths.length ||
    rawTags > selection.tags.length;
  if (selectionLimitsHit) {
    truncationReasons.push(
      `消息内提及达到上限：文件 ${limits.maxFilesInMessage}、文件夹 ${limits.maxFoldersInMessage}、标签 ${limits.maxTagsInMessage}`,
    );
  }
  if (input.contentTruncated) {
    truncationReasons.push(
      `文件正文达到上限：单文件 ${limits.maxCharsPerFile} 字，总计 ${limits.maxCharsTotal} 字`,
    );
  }

  const lineParts = items
    .filter((i) => i.kind !== "expanded")
    .map((i) => i.label)
    .slice(0, 6);
  if (items.length > 6) lineParts.push(`+${items.length - 6}`);
  if (truncated) lineParts.push("已截断");

  return {
    items,
    truncated,
    line: lineParts.length ? lineParts.join(" · ") : "本轮无额外上下文",
    truncationReasons: Array.from(new Set(truncationReasons)),
  };
}

function basename(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "") || name;
}

function countRawMentions(message: string, pattern: RegExp): number {
  return Array.from(message.matchAll(pattern)).length;
}
