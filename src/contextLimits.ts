/** Shared vault-context caps used by the plugin and UI summary. */
export interface ContextLimits {
  maxFilesInMessage: number;
  maxFoldersInMessage: number;
  maxTagsInMessage: number;
  maxExpandedPaths: number;
  maxFilesPerFolder: number;
  maxFilesPerTag: number;
  maxCharsPerFile: number;
  maxCharsTotal: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxFilesInMessage: 8,
  maxFoldersInMessage: 4,
  maxTagsInMessage: 6,
  maxExpandedPaths: 32,
  maxFilesPerFolder: 20,
  maxFilesPerTag: 20,
  maxCharsPerFile: 50_000,
  maxCharsTotal: 180_000,
};

export type ContextLimitOverrides = Partial<ContextLimits>;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Merge user overrides with defaults; invalid values fall back to defaults. */
export function mergeContextLimits(overrides?: ContextLimitOverrides | null): ContextLimits {
  const o = overrides ?? {};
  const d = DEFAULT_CONTEXT_LIMITS;
  return {
    maxFilesInMessage: clampInt(o.maxFilesInMessage, 1, 64, d.maxFilesInMessage),
    maxFoldersInMessage: clampInt(o.maxFoldersInMessage, 0, 32, d.maxFoldersInMessage),
    maxTagsInMessage: clampInt(o.maxTagsInMessage, 0, 32, d.maxTagsInMessage),
    maxExpandedPaths: clampInt(o.maxExpandedPaths, 1, 200, d.maxExpandedPaths),
    maxFilesPerFolder: clampInt(o.maxFilesPerFolder, 1, 200, d.maxFilesPerFolder),
    maxFilesPerTag: clampInt(o.maxFilesPerTag, 1, 200, d.maxFilesPerTag),
    maxCharsPerFile: clampInt(o.maxCharsPerFile, 1_000, 500_000, d.maxCharsPerFile),
    maxCharsTotal: clampInt(o.maxCharsTotal, 5_000, 2_000_000, d.maxCharsTotal),
  };
}
