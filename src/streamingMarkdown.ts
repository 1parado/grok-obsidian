/**
 * Lightweight streaming Markdown structure hints for plain-text display
 * before full Obsidian MarkdownRenderer runs on completion.
 * Keeps headings / fences / lists readable without full HTML parse.
 */
export function formatStreamingMarkdownPreview(text: string, maxChars = 120_000): string {
  if (!text) return "";
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
  // Preserve structure; UI may still render as pre-wrap text with classes.
  return clipped;
}

/** Detect if text has markdown structure worth structured rendering. */
export function hasMarkdownStructure(text: string): boolean {
  if (!text) return false;
  return (
    /^#{1,6}\s/m.test(text) ||
    /^```/m.test(text) ||
    /^[-*+]\s/m.test(text) ||
    /^\d+\.\s/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /`[^`]+`/.test(text) ||
    /^\|.+\|/m.test(text) ||
    /^>\s/m.test(text)
  );
}

/**
 * Throttle helper: returns true when enough time has passed since last render.
 */
export function shouldThrottleRender(lastRenderAt: number, now: number, minIntervalMs = 120): boolean {
  return now - lastRenderAt >= minIntervalMs;
}
