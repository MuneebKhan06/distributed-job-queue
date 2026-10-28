/** Thrown when a request is abandoned for taking longer than its limit. */
export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`No answer within ${Math.round(ms / 1000)} seconds`);
    this.name = "TimeoutError";
  }
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * fetch, but it gives up after timeoutMs.
 *
 * A browser waits minutes on a server that accepts the connection and then
 * says nothing, for example an API whose container is paused or stuck. Until
 * then every poll sat pending, and screens kept showing their last good
 * answer as if it were current: the health dots stayed green throughout.
 *
 * The limit covers the wait for the response headers, which is where a stuck
 * server hangs. A plain setTimeout is used rather than AbortSignal.timeout so
 * the tests can drive it with fake timers.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (caught) {
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs);
    }
    throw caught;
  } finally {
    clearTimeout(timer);
  }
}
