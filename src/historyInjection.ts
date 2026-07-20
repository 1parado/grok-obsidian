/**
 * Decide whether to inject recent local conversation history into the prompt.
 *
 * - Always inject when the current turn has images (ACP may start a fresh process).
 * - Inject when there is no resumable session id.
 * - Inject on text turns after a prior image/ACP turn, because ACP session ids may
 *   not resume correctly under headless --resume.
 */
export function shouldInjectLocalHistory(input: {
  hasImageAttachments: boolean;
  hasSessionId: boolean;
  lastTurnUsedAcp: boolean;
}): boolean {
  if (input.hasImageAttachments) return true;
  if (!input.hasSessionId) return true;
  if (input.lastTurnUsedAcp) return true;
  return false;
}
