/**
 * @nmrtn/blacktea
 *
 * Public exports. The factory and the types a customer wires into their
 * agent. Rail adapters live under @nmrtn/blacktea/adapters and stay out
 * of this barrel so plain consumers do not pay for unused rail clients.
 */

export const VERSION = "0.1.3";

export { blacktea } from "./agent.js";
export type { BlackteaOptions, PayFunction } from "./agent.js";

export type {
  ApprovalChannel,
  ApprovalDecision,
  ApprovalRequest,
  AuditEvent,
  AuditSink,
  HistoryFilter,
  HistoryQuery,
  HistoryRecord,
  HistoryStore,
  IdempotencyStore,
  OnApprovalNeeded,
  PayInput,
  PayOptions,
  PaymentIntent,
  PaymentIntentInput,
  PaymentIntentStatus,
  PaymentRequirement,
  RailAdapter,
  Receipt,
  SettleResult,
  StagedIntent,
  StageResult,
} from "./types.js";

export {
  ApprovalTimeoutError,
  NetworkError,
  NoEligibleRailError,
  PolicyDeniedError,
  PolicyParseError,
  RailUnavailableError,
  ValidationError,
  isBlackteaError,
} from "./errors.js";

export type {
  ApprovalFinalState,
  ApprovalRecord,
  ApprovalRoute,
} from "./approval-record.js";
export type { Policy, PolicyAction, PolicyCondition, PolicyRule } from "./policy/schema.js";
export { PolicySchema } from "./policy/schema.js";
export { loadPolicy } from "./policy/load.js";

export { InMemoryIdempotencyStore } from "./idempotency/in-memory.js";
export { FileBackedHistoryStore } from "./history/file-backed.js";
