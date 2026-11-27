/**
 * The host (name and port, lowercased) of a URL, or the input itself when
 * it does not parse as one. Per-URL policy limits are per host: the policy
 * evaluator asks history for a host, and history stores full request URLs,
 * so both sides go through this.
 */
export function hostOf(url: string): string {
  try {
    // "example.com." reaches the same server as "example.com", so one
    // trailing dot is dropped rather than counted as another host.
    return new URL(url).host.replace(/\.(?=:\d+$|$)/, "");
  } catch {
    return url;
  }
}
