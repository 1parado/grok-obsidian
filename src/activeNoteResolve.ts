/**
 * Resolve which vault note should count as "active note" for chat context.
 * Prefers the currently focused Markdown path when present; otherwise falls
 * back to the last-focused Markdown path (so Grok sidebar focus still works).
 */
export function resolveActiveNotePath(input: {
  includeActiveNote: boolean;
  currentMarkdownPath: string | null | undefined;
  lastMarkdownPath: string | null | undefined;
}): string | null {
  if (!input.includeActiveNote) return null;
  const current = normalizeOptionalPath(input.currentMarkdownPath);
  if (current) return current;
  return normalizeOptionalPath(input.lastMarkdownPath);
}

export function activeNoteChipLabel(path: string | null | undefined): string {
  if (!path) return "无笔记";
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "") || "无笔记";
}

function normalizeOptionalPath(path: string | null | undefined): string | null {
  if (!path || typeof path !== "string") return null;
  const trimmed = path.trim().replace(/\\/g, "/");
  return trimmed || null;
}
