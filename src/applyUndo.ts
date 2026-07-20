export interface FileSnapshot {
  path: string;
  /** Previous file body; null means the file did not exist (created by apply). */
  before: string | null;
}

export interface ApplyUndoEntry {
  id: string;
  createdAt: number;
  snapshots: FileSnapshot[];
  /** Soft expiry for UI "undo" offer. */
  expiresAt: number;
}

export const DEFAULT_UNDO_TTL_MS = 30_000;

export function createApplyUndoEntry(
  snapshots: FileSnapshot[],
  now = Date.now(),
  ttlMs = DEFAULT_UNDO_TTL_MS,
): ApplyUndoEntry {
  return {
    id: `undo-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: now,
    snapshots: snapshots.map((s) => ({ path: s.path, before: s.before })),
    expiresAt: now + Math.max(0, ttlMs),
  };
}

export function isUndoEntryValid(entry: ApplyUndoEntry | null | undefined, now = Date.now()): boolean {
  if (!entry || !entry.snapshots?.length) return false;
  return now <= entry.expiresAt;
}

/**
 * Compute reverse actions for undo: restore `before` content, or delete if before was null.
 */
export function planUndoActions(entry: ApplyUndoEntry): Array<
  { path: string; action: "restore"; content: string } | { path: string; action: "delete" }
> {
  return entry.snapshots.map((snap) =>
    snap.before === null
      ? { path: snap.path, action: "delete" as const }
      : { path: snap.path, action: "restore" as const, content: snap.before },
  );
}

/** Merge successive applies into one undo stack head (replace previous pending undo). */
export function pushUndoEntry(
  previous: ApplyUndoEntry | null,
  next: ApplyUndoEntry,
  now = Date.now(),
): ApplyUndoEntry {
  // Only keep the latest apply for a short undo window (simpler UX).
  void previous;
  void now;
  return next;
}
