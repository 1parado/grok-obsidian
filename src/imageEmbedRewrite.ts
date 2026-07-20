/**
 * Rewrite hallucinated or missing image embeds in model replies so they point
 * at real vault attachment paths from the current turn.
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** ACP/session-style names models invent, e.g. image-ca30f9c0-0de2-....png */
const HALLUCINATED_IMAGE_RE =
  /^(?:image[-_])?[0-9a-f]{8}(?:-[0-9a-f]{4}){1,4}[-0-9a-f]*\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;

export interface ImageEmbedRewrite {
  from: string;
  to: string;
}

export interface RewriteImageEmbedsResult {
  text: string;
  rewrites: ImageEmbedRewrite[];
}

export interface RewriteImageEmbedsOptions {
  /**
   * Return true when the vault-relative path (or a resolvable basename) exists.
   * When provided, non-hallucinated missing image embeds are also rewritten.
   */
  pathExists?: (vaultRelativePath: string) => boolean;
}

function normalizePath(raw: string): string {
  let path = raw.trim();
  path = path.replace(/^["'`]+|["'`]+$/g, "");
  path = path.replace(/\\/g, "/");
  path = path.replace(/^\.?\//, "");
  path = path.replace(/^\/+/, "");
  return path.trim();
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

/** Strip Obsidian wiki target extras: path|alias, path#heading, path^block */
function wikiTargetPath(inner: string): string {
  let target = inner.trim();
  target = target.split("|")[0] ?? target;
  target = target.split("#")[0] ?? target;
  target = target.split("^")[0] ?? target;
  return normalizePath(target);
}

export function isHallucinatedImageName(pathOrName: string): boolean {
  return HALLUCINATED_IMAGE_RE.test(basename(pathOrName));
}

export function isImagePath(pathOrName: string): boolean {
  const name = basename(pathOrName);
  return IMAGE_EXT_RE.test(name) || isHallucinatedImageName(name);
}

function pathMatchesKnown(target: string, known: string): boolean {
  const t = normalizePath(target);
  const k = normalizePath(known);
  if (!t || !k) return false;
  if (t === k) return true;
  return basename(t) === basename(k);
}

function findKnownMatch(target: string, knownPaths: string[]): string | null {
  return knownPaths.find((known) => pathMatchesKnown(target, known)) ?? null;
}

/**
 * Decide whether an embed target should be replaced with a known attachment path.
 * Returns the replacement path, or null to leave the embed unchanged.
 */
export function resolveImageEmbedTarget(
  target: string,
  knownPaths: string[],
  nextKnownIndex: { value: number },
  options: RewriteImageEmbedsOptions = {},
): string | null {
  const known = knownPaths.map(normalizePath).filter(Boolean);
  if (known.length === 0) return null;

  const normalized = normalizePath(target);
  if (!normalized || !isImagePath(normalized)) return null;

  const exact = findKnownMatch(normalized, known);
  if (exact) {
    // Prefer the canonical vault path stored by the plugin when basenames match.
    return exact !== normalized ? exact : null;
  }

  const exists = options.pathExists?.(normalized) === true;
  if (exists) return null;

  const hallucinated = isHallucinatedImageName(normalized);
  // Without a vault existence check, only rewrite clearly invented session/asset names.
  if (!options.pathExists && !hallucinated) return null;
  // With existence check: rewrite missing image embeds (including non-UUID typos).
  if (options.pathExists && !hallucinated && exists) return null;

  const index = Math.min(nextKnownIndex.value, known.length - 1);
  nextKnownIndex.value = Math.min(nextKnownIndex.value + 1, known.length);
  return known[index] ?? null;
}

/**
 * Replace wiki `![[...]]` and markdown `![](...)` / `![alt](...)` image targets
 * that do not point at real attachment paths for this turn.
 */
export function rewriteImageEmbeds(
  text: string,
  knownPaths: string[],
  options: RewriteImageEmbedsOptions = {},
): RewriteImageEmbedsResult {
  if (!text || knownPaths.length === 0) {
    return { text, rewrites: [] };
  }

  const known = knownPaths.map(normalizePath).filter(Boolean);
  if (known.length === 0) return { text, rewrites: [] };

  const rewrites: ImageEmbedRewrite[] = [];
  const nextKnownIndex = { value: 0 };
  let output = text;

  // Wiki image embeds: ![[path]] ![[path|alias]] ![[path#heading]]
  output = output.replace(/!\[\[([^\]]+)\]\]/g, (full, inner: string) => {
    const target = wikiTargetPath(inner);
    if (!target || !isImagePath(target)) return full;
    const replacement = resolveImageEmbedTarget(target, known, nextKnownIndex, options);
    if (!replacement) return full;
    rewrites.push({ from: target, to: replacement });
    // Preserve alias / display text when present after |
    const aliasPart = inner.includes("|") ? inner.slice(inner.indexOf("|")) : "";
    return `![[${replacement}${aliasPart}]]`;
  });

  // Markdown images: ![alt](path) — skip remote URLs and data URIs
  output = output.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (full, alt: string, rawUrl: string) => {
      const url = rawUrl.trim().replace(/^<|>$/g, "");
      if (/^(https?:|data:|app:|obsidian:)/i.test(url)) return full;
      const target = normalizePath(url);
      if (!target || !isImagePath(target)) return full;
      const replacement = resolveImageEmbedTarget(target, known, nextKnownIndex, options);
      if (!replacement) return full;
      rewrites.push({ from: target, to: replacement });
      // Prefer Obsidian wiki embeds for vault files (stable across moves by basename).
      return `![[${replacement}]]`;
    },
  );

  return { text: output, rewrites };
}

/** Collect vault paths from chat attachments (deduped, order preserved). */
export function attachmentVaultPaths(
  attachments: Array<{ path?: string } | null | undefined> | null | undefined,
): string[] {
  if (!attachments?.length) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const item of attachments) {
    const path = normalizePath(item?.path ?? "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
