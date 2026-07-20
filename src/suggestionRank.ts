export interface RankableSuggestion {
  kind: "file" | "folder" | "tag" | "prompt";
  key: string;
  title: string;
  subtitle: string;
  path?: string;
  prompt?: string;
  /** Optional mtime ms for recent-file bias. */
  mtime?: number;
}

/**
 * Score a suggestion against a normalized (lowercase) query.
 * Lower is better. 99 = no match.
 */
export function matchScore(title: string, subtitle: string, query: string): number {
  if (!query) return 0;
  const value = `${title} ${subtitle}`.toLocaleLowerCase();
  if (value.startsWith(query)) return 0;
  if (title.toLocaleLowerCase().startsWith(query)) return 0;
  if (value.includes(query)) return 1;
  return 99;
}

/**
 * Rank @ suggestions. Empty/short queries prefer recent files (by mtime).
 * Folders keep normal alphabetical secondary order when scores tie on search.
 */
export function rankAtSuggestions(
  items: RankableSuggestion[],
  query: string,
  options: { limit?: number; recentBiasMaxQueryLen?: number } = {},
): RankableSuggestion[] {
  const limit = options.limit ?? 100;
  const recentBiasMax = options.recentBiasMaxQueryLen ?? 1;
  const preferRecent = query.length <= recentBiasMax;

  return items
    .map((item) => ({ item, score: matchScore(item.title, item.subtitle, query) }))
    .filter((entry) => entry.score < 99 || (!query && entry.item.kind === "file"))
    .filter((entry) => (query ? entry.score < 99 : true))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (preferRecent && a.item.kind === "file" && b.item.kind === "file") {
        const am = a.item.mtime ?? 0;
        const bm = b.item.mtime ?? 0;
        if (am !== bm) return bm - am;
      }
      // Prefer files slightly over folders when empty query + same score.
      if (preferRecent && !query) {
        if (a.item.kind === "file" && b.item.kind !== "file") return -1;
        if (b.item.kind === "file" && a.item.kind !== "file") return 1;
      }
      return a.item.title.localeCompare(b.item.title);
    })
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function rankTagSuggestions(
  tags: string[],
  query: string,
  limit = 80,
): RankableSuggestion[] {
  return tags
    .map((tag) => ({
      kind: "tag" as const,
      key: tag,
      title: `#${tag}`,
      subtitle: "Vault 标签",
    }))
    .map((item) => ({ item, score: matchScore(item.title, item.subtitle, query) }))
    .filter((entry) => entry.score < 99)
    .sort(
      (a, b) =>
        a.score - b.score || a.item.title.localeCompare(b.item.title),
    )
    .slice(0, limit)
    .map((entry) => entry.item);
}
