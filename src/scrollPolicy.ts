/** Distance from bottom (px) at which auto-scroll is still considered "near bottom". */
export const NEAR_BOTTOM_THRESHOLD_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** True when the user is within threshold of the transcript bottom. */
export function isNearBottom(
  metrics: ScrollMetrics,
  thresholdPx: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  const distance = metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight);
  return distance <= Math.max(0, thresholdPx);
}

/**
 * Whether streaming/append updates should auto-scroll the chat.
 * Only scroll when the user is already near the bottom.
 */
export function shouldAutoScrollOnUpdate(
  metrics: ScrollMetrics,
  thresholdPx: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  return isNearBottom(metrics, thresholdPx);
}

/** Whether to show a "jump to latest" control after content grows while scrolled up. */
export function shouldShowJumpToLatest(
  metrics: ScrollMetrics,
  contentGrew: boolean,
  thresholdPx: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  return contentGrew && !isNearBottom(metrics, thresholdPx);
}
