export interface ParsedContextSelection {
  filePaths: string[];
  folderPaths: string[];
  tags: string[];
}

const DEFAULT_LIMITS = {
  files: 8,
  folders: 4,
  tags: 6,
} as const;

export interface ContextParseLimits {
  files?: number;
  folders?: number;
  tags?: number;
}

/**
 * Parse @[[file]], @{folder}, and #tag tokens from a user message.
 * Tag matching is exact (with optional leading #); hierarchical parents are not expanded here.
 */
export function parseContextSelection(
  message: string,
  limits: ContextParseLimits = {},
): ParsedContextSelection {
  const fileLimit = limits.files ?? DEFAULT_LIMITS.files;
  const folderLimit = limits.folders ?? DEFAULT_LIMITS.folders;
  const tagLimit = limits.tags ?? DEFAULT_LIMITS.tags;

  const filePaths = Array.from(message.matchAll(/@\[\[([^\]]+)\]\]/g), (match) => match[1].trim());
  const folderPaths = Array.from(message.matchAll(/@\{([^}]+)\}/g), (match) => match[1].trim());
  const tags = Array.from(
    message.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu),
    (match) => match[1].trim(),
  );

  return {
    filePaths: unique(filePaths).slice(0, fileLimit),
    folderPaths: unique(folderPaths).slice(0, folderLimit),
    tags: unique(tags).slice(0, tagLimit),
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/** Match vault tags: exact, or hierarchical parent/child (e.g. work matches work/notes). */
export function tagMatches(candidate: string, selected: string): boolean {
  const a = candidate.replace(/^#/, "").toLocaleLowerCase();
  const b = selected.replace(/^#/, "").toLocaleLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
