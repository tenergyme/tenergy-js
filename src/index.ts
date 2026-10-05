// @tenergy/sdk — the typed client for `docs/api/openapi.yaml`.
//
// `src/generated/openapi.ts` is generated (`pnpm --filter @tenergy/sdk generate`) and is never
// hand-edited: the contract is the source of truth, and a hand-patched type is a second contract.
export {
  TenergyClient,
  TENERGY_API_URLS,
  DEFAULT_RETRY,
  SETTLED_ORDER_STATUSES,
  encodeQuery,
} from './client.js';
export type {
  Account,
  ApiKeyScope,
  BootstrapInput,
  BootstrapResult,
  FetchLike,
  OperationId,
  Order,
  OrderStatus,
  Quote,
  ResponseInfo,
  RetryPolicy,
  Schemas,
  TenergyClientOptions,
  TenergyNetwork,
  WaitForOrderOptions,
} from './client.js';
export {
  TenergyApiError,
  TenergyError,
  TenergyTimeoutError,
  TenergyTransportError,
  isErrorEnvelope,
} from './errors.js';
export type { ErrorEnvelope } from './errors.js';
export {
  apiTimestamp,
  canonicalString,
  signRequest,
  splitUrl,
  verifyWebhookSignature,
  webhookSignature,
} from './signing.js';
export type { CanonicalRequest } from './signing.js';
export type { components, operations, paths } from './generated/openapi.js';
