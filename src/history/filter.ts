/**
 * Whether a history record falls inside a HistoryFilter. Shared by every
 * place that answers a history query, so a per-wallet or per-host limit
 * counts the same payments everywhere.
 */

import { hostOf } from "../host.js";
import type { HistoryFilter, HistoryRecord } from "../types.js";

export function matchesFilter(event: HistoryRecord, filter: HistoryFilter | undefined): boolean {
  if (!filter) return true;
  // Letter case is ignored, as in the policy's wallet_in: a payee must not
  // escape a per-wallet limit by changing the casing of its address.
  if (filter.wallet && event.recipient_wallet?.toLowerCase() !== filter.wallet.toLowerCase()) {
    return false;
  }
  // filter.url is a host; records hold the full request URL.
  if (filter.url && (!event.recipient_url || hostOf(event.recipient_url) !== filter.url)) {
    return false;
  }
  return true;
}
