// `TenergyClient` — one typed method per `operationId` in `docs/api/openapi.yaml`.
//
// Everything the client does that is not "serialize, send, deserialize" is here for a reason:
//
//   * **Every request is signed** with the scheme the API verifies, over
//     the exact bytes about to be transmitted. The body is serialized ONCE and both the signature
//     and the request use that string; re-serializing for the signature would break the first
//     time a key order changed.
//   * **A signature is single-use inside the skew window** (`errors.md` 1009), so every attempt —
//     including every retry — gets a fresh timestamp and a fresh signature. A client that reuses
//     them turns a transient 503 into a permanent `1009 replayed_signature`.
//   * **Retries only on idempotent calls.** GET and DELETE are retried; POST and PATCH are not,
//     because a POST that timed out may well have been executed. To make a create safe to repeat,
//     send `client_order_id` (or an `Idempotency-Key`) and repeat it yourself: the api settles it
//     against its own unique index, which is the only place it can be settled correctly.
import type { components, operations } from './generated/openapi.js';
import {
  TenergyApiError,
  TenergyTimeoutError,
  TenergyTransportError,
  isErrorEnvelope,
} from './errors.js';
import { apiTimestamp, signRequest } from './signing.js';

// ---- types lifted out of the generated contract ------------------------------------------------

type Operations = operations;
export type OperationId = keyof Operations;
export type Schemas = components['schemas'];

type JsonOf<T> = T extends { content: { 'application/json': infer B } } ? B : never;

type RequestBodyOf<Op extends OperationId> = Operations[Op] extends { requestBody?: infer R }
  ? JsonOf<NonNullable<R>>
  : never;

type QueryOf<Op extends OperationId> = Operations[Op]['parameters'] extends { query?: infer Q }
  ? NonNullable<Q>
  : never;

type SuccessStatus = 200 | 201 | 202 | 204;

/**
 * The union of the 2xx bodies an operation may answer with. `createOrder` really does answer
 * either 201 (created) or 200 (a replay of the same `client_order_id`) with the same schema, so
 * this is a union of one in practice and never a lie in principle.
 */
type ResponseOf<Op extends OperationId> = Operations[Op]['responses'] extends infer R
  ? { [S in Extract<keyof R, SuccessStatus>]: JsonOf<R[S]> }[Extract<keyof R, SuccessStatus>]
  : never;

export type Order = Schemas['Order'];
export type OrderStatus = Schemas['OrderStatus'];
export type Quote = Schemas['Quote'];
export type Account = Schemas['Account'];
export type ApiKeyScope = Schemas['ApiKeyScope'];

// ---- transport ---------------------------------------------------------------------------------

/**
 * The slice of `fetch` this package uses. Declared structurally so `globalThis.fetch`, undici's
 * `fetch` and a test double that answers from `fastify.inject` are all valid without a cast.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface RetryPolicy {
  /** Extra attempts after the first, for idempotent calls only. Default 2. */
  maxRetries: number;
  /** Base backoff in ms; attempt n waits `baseDelayMs * 2^n` unless `Retry-After` says more. */
  baseDelayMs: number;
  /** Ceiling on one wait. Default 5 s. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
});

/** HTTP methods that may be repeated safely. Everything else is sent at most once. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

/**
 * The two public API hosts. `network` picks one; `baseUrl` overrides both (a self-hosted or
 * local API). Mainnet is the default, so a production integration needs no option at all.
 */
export const TENERGY_API_URLS = Object.freeze({
  mainnet: 'https://api.tenergy.me/v1',
  nile: 'https://api-nile.tenergy.me/v1',
} as const);

export type TenergyNetwork = keyof typeof TENERGY_API_URLS;

export interface TenergyClientOptions {
  /** `'mainnet'` (default) or `'nile'`, the TRON testnet sandbox with its own keys and balance. */
  network?: TenergyNetwork;
  /** Overrides `network`: an API root including `/v1`, e.g. `http://localhost:3000/v1`. */
  baseUrl?: string;
  /** `ak_live_…` / `ak_test_…`, shown at key creation. Not needed for the bootstrap flow. */
  apiKey?: string;
  /** `sk_live_…` / `sk_test_…`, handed out once with the key. Never sent, only used to sign. */
  apiSecret?: string;
  fetch?: FetchLike;
  /** Per-request timeout in ms. Default 15 s. */
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Injected clock, epoch ms. Production is `Date.now`; tests freeze it. */
  now?: () => number;
  /** Injected sleep, so a retry test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Extra headers on every request. Never allowed to override the signed auth headers. */
  headers?: Record<string, string>;
  userAgent?: string;
  /**
   * Called once per HTTP answer (every attempt, success or error) with its status. The typed
   * methods return only the body; a caller that must tell a replayed create (`200`) from a new
   * one (`201`), or log request ids, reads it here — the compat facades use it for that.
   */
  onResponse?: (info: ResponseInfo) => void;
}

export interface ResponseInfo {
  method: string;
  /** The signed path, including `/v1` and the query. */
  path: string;
  status: number;
  requestId: string | null;
  /**
   * The JSON body this answer belongs to, as sent (`''` for none) — so creates running in
   * parallel can be told apart by their `client_order_id`. Never carries a secret: auth is in
   * headers, and headers are not reported.
   */
  requestBody: string;
}

interface CallOptions<Op extends OperationId> {
  query?: QueryOf<Op> | undefined;
  body?: RequestBodyOf<Op> | undefined;
  /** Sent as `Idempotency-Key` where the contract accepts one. */
  idempotencyKey?: string | undefined;
  /**
   * `api-key` (default), `bootstrap` for `abt_…`, `none` for the anonymous signup calls, or
   * `optional` for the public reads (`/prices`, `/estimate`, `/resources/{address}`): signed when
   * the client holds a key — the api still verifies a presented key and bills it to that key's
   * budget — and sent anonymously when it does not.
   */
  auth?: 'api-key' | 'bootstrap' | 'none' | 'optional' | undefined;
  bootstrapToken?: string | undefined;
}

export interface WaitForOrderOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Stop as soon as the order reaches one of these. Default: every terminal-for-the-caller state. */
  until?: readonly OrderStatus[];
}

/** Where `waitForOrder` stops by default: the customer either has their energy or will not get it. */
export const SETTLED_ORDER_STATUSES: readonly OrderStatus[] = Object.freeze([
  'active',
  'expired',
  'reclaimed',
  'failed',
  'refunded',
]);

export class TenergyClient {
  readonly baseUrl: string;
  /** The network picked by `network`; `null` when `baseUrl` pointed the client elsewhere. */
  readonly network: TenergyNetwork | null;

  private readonly apiKey: string | undefined;
  private readonly apiSecret: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly extraHeaders: Record<string, string>;
  private readonly userAgent: string;
  private readonly onResponse: ((info: ResponseInfo) => void) | undefined;

  constructor(options: TenergyClientOptions) {
    const network = options.network ?? 'mainnet';
    if (!Object.hasOwn(TENERGY_API_URLS, network)) {
      throw new TypeError(`TenergyClient: network must be 'mainnet' or 'nile', got ${String(network)}`);
    }
    if (options.baseUrl !== undefined && (typeof options.baseUrl !== 'string' || options.baseUrl === '')) {
      throw new TypeError('TenergyClient: baseUrl must be a non-empty URL, e.g. http://localhost:3000/v1');
    }
    // A key belongs to one network: `ak_test_` keys exist only on Nile, `ak_live_` only on
    // mainnet. Said here, at construction, instead of as a 401 on the first signed call.
    if (options.baseUrl === undefined && options.apiKey !== undefined) {
      if (network === 'mainnet' && options.apiKey.startsWith('ak_test_')) {
        throw new TypeError("TenergyClient: an ak_test_ key belongs to the Nile sandbox — pass { network: 'nile' }");
      }
      if (network === 'nile' && options.apiKey.startsWith('ak_live_')) {
        throw new TypeError("TenergyClient: an ak_live_ key belongs to mainnet — drop { network: 'nile' }");
      }
    }
    this.network = options.baseUrl === undefined ? network : null;
    // Trailing slashes are stripped so the signed path is exactly what the api routes on: a
    // request to `…/v1//orders` signs `//orders` and is refused with 1008, which is a miserable
    // thing to debug.
    this.baseUrl = (options.baseUrl ?? TENERGY_API_URLS[network]).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('TenergyClient: no fetch available; pass one in options.fetch');
    }
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.extraHeaders = options.headers ?? {};
    this.userAgent = options.userAgent ?? 'tenergy-sdk-ts/0.1.0-beta.0';
    this.onResponse = options.onResponse;
  }

  // ---- Signup (anonymous, then bootstrap token) ------------------------------------------------

  createAccountChallenge(
    body: RequestBodyOf<'createAccountChallenge'>,
  ): Promise<ResponseOf<'createAccountChallenge'>> {
    return this.call('POST', '/accounts/challenge', { body, auth: 'none' });
  }

  verifyAccountChallenge(
    body: RequestBodyOf<'verifyAccountChallenge'>,
  ): Promise<ResponseOf<'verifyAccountChallenge'>> {
    return this.call('POST', '/accounts/challenge/verify', { body, auth: 'none' });
  }

  createAccount(
    body: RequestBodyOf<'createAccount'>,
    options: { bootstrapToken?: string } = {},
  ): Promise<ResponseOf<'createAccount'>> {
    return this.call('POST', '/accounts', {
      body,
      auth: options.bootstrapToken === undefined ? 'none' : 'bootstrap',
      bootstrapToken: options.bootstrapToken,
    });
  }

  getSignupDepositAddress(
    bootstrapToken: string,
    query?: QueryOf<'getSignupDepositAddress'>,
  ): Promise<ResponseOf<'getSignupDepositAddress'>> {
    return this.call('GET', '/accounts/deposit-address', {
      query,
      auth: 'bootstrap',
      bootstrapToken,
    });
  }

  // ---- Account --------------------------------------------------------------------------------

  getAccount(options: { bootstrapToken?: string } = {}): Promise<ResponseOf<'getAccount'>> {
    return this.call('GET', '/account', {
      auth: options.bootstrapToken === undefined ? 'api-key' : 'bootstrap',
      bootstrapToken: options.bootstrapToken,
    });
  }

  getBalance(): Promise<ResponseOf<'getBalance'>> {
    return this.call('GET', '/balance', {});
  }

  listDepositAddresses(): Promise<ResponseOf<'listDepositAddresses'>> {
    return this.call('GET', '/deposit-addresses', {});
  }

  // ---- Pricing --------------------------------------------------------------------------------

  getPrices(query?: QueryOf<'getPrices'>): Promise<ResponseOf<'getPrices'>> {
    return this.call('GET', '/prices', { query, auth: 'optional' });
  }

  estimateOrder(query: QueryOf<'estimateOrder'>): Promise<ResponseOf<'estimateOrder'>> {
    return this.call('GET', '/estimate', { query, auth: 'optional' });
  }

  /**
   * The ask ladder: how much energy is available at which price, cheapest first. Anonymous —
   * no key needed — and cached for a few seconds, so it is safe to poll while a buyer moves a
   * slider. Pass `amount` to get the walk for that size back with the levels.
   */
  getOrderBook(query?: QueryOf<'getOrderBook'>): Promise<ResponseOf<'getOrderBook'>> {
    return this.call('GET', '/orderbook', { query, auth: 'none' });
  }

  createQuote(
    body: RequestBodyOf<'createQuote'>,
    options: { idempotencyKey?: string } = {},
  ): Promise<ResponseOf<'createQuote'>> {
    return this.call('POST', '/quotes', { body, idempotencyKey: options.idempotencyKey });
  }

  getQuote(quoteId: string): Promise<ResponseOf<'getQuote'>> {
    return this.call('GET', `/quotes/${encodeURIComponent(quoteId)}`, {});
  }

  // ---- Orders ---------------------------------------------------------------------------------

  createOrder(
    body: RequestBodyOf<'createOrder'>,
    options: { idempotencyKey?: string } = {},
  ): Promise<ResponseOf<'createOrder'>> {
    return this.call('POST', '/orders', { body, idempotencyKey: options.idempotencyKey });
  }

  listOrders(query?: QueryOf<'listOrders'>): Promise<ResponseOf<'listOrders'>> {
    return this.call('GET', '/orders', { query });
  }

  /** Accepts our order id, or `cid:<client_order_id>` (openapi `getOrder`). */
  getOrder(orderId: string): Promise<ResponseOf<'getOrder'>> {
    return this.call('GET', `/orders/${encodeURIComponent(orderId)}`, {});
  }

  reclaimOrder(
    orderId: string,
    options: { idempotencyKey?: string } = {},
  ): Promise<ResponseOf<'reclaimOrder'>> {
    return this.call('POST', `/orders/${encodeURIComponent(orderId)}/reclaim`, {
      idempotencyKey: options.idempotencyKey,
    });
  }

  // ---- Batches --------------------------------------------------------------------------------

  createBatch(
    body: RequestBodyOf<'createBatch'>,
    options: { idempotencyKey?: string } = {},
  ): Promise<ResponseOf<'createBatch'>> {
    return this.call('POST', '/batches', { body, idempotencyKey: options.idempotencyKey });
  }

  listBatches(query?: QueryOf<'listBatches'>): Promise<ResponseOf<'listBatches'>> {
    return this.call('GET', '/batches', { query });
  }

  getBatch(batchId: string, query?: QueryOf<'getBatch'>): Promise<ResponseOf<'getBatch'>> {
    return this.call('GET', `/batches/${encodeURIComponent(batchId)}`, { query });
  }

  cancelBatch(batchId: string): Promise<ResponseOf<'cancelBatch'>> {
    return this.call('POST', `/batches/${encodeURIComponent(batchId)}/cancel`, {});
  }

  // ---- Subscriptions --------------------------------------------------------------------------

  createSubscription(
    body: RequestBodyOf<'createSubscription'>,
    options: { idempotencyKey?: string } = {},
  ): Promise<ResponseOf<'createSubscription'>> {
    return this.call('POST', '/subscriptions', { body, idempotencyKey: options.idempotencyKey });
  }

  listSubscriptions(query?: QueryOf<'listSubscriptions'>): Promise<ResponseOf<'listSubscriptions'>> {
    return this.call('GET', '/subscriptions', { query });
  }

  getSubscription(subscriptionId: string): Promise<ResponseOf<'getSubscription'>> {
    return this.call('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {});
  }

  updateSubscription(
    subscriptionId: string,
    body: RequestBodyOf<'updateSubscription'>,
  ): Promise<ResponseOf<'updateSubscription'>> {
    return this.call('PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, { body });
  }

  cancelSubscription(subscriptionId: string): Promise<ResponseOf<'cancelSubscription'>> {
    return this.call('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {});
  }

  // ---- Webhooks -------------------------------------------------------------------------------

  createWebhook(body: RequestBodyOf<'createWebhook'>): Promise<ResponseOf<'createWebhook'>> {
    return this.call('POST', '/webhooks', { body });
  }

  listWebhooks(): Promise<ResponseOf<'listWebhooks'>> {
    return this.call('GET', '/webhooks', {});
  }

  getWebhook(webhookId: string): Promise<ResponseOf<'getWebhook'>> {
    return this.call('GET', `/webhooks/${encodeURIComponent(webhookId)}`, {});
  }

  updateWebhook(
    webhookId: string,
    body: RequestBodyOf<'updateWebhook'>,
  ): Promise<ResponseOf<'updateWebhook'>> {
    return this.call('PATCH', `/webhooks/${encodeURIComponent(webhookId)}`, { body });
  }

  deleteWebhook(webhookId: string): Promise<ResponseOf<'deleteWebhook'>> {
    return this.call('DELETE', `/webhooks/${encodeURIComponent(webhookId)}`, {});
  }

  rotateWebhookSecret(webhookId: string): Promise<ResponseOf<'rotateWebhookSecret'>> {
    return this.call('POST', `/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`, {});
  }

  testWebhook(
    webhookId: string,
    body?: RequestBodyOf<'testWebhook'>,
  ): Promise<ResponseOf<'testWebhook'>> {
    return this.call('POST', `/webhooks/${encodeURIComponent(webhookId)}/test`, { body });
  }

  /** Delivery attempts of one endpoint, newest first: status code, latency, next retry. */
  listWebhookDeliveries(
    webhookId: string,
    query?: QueryOf<'listWebhookDeliveries'>,
  ): Promise<ResponseOf<'listWebhookDeliveries'>> {
    return this.call('GET', `/webhooks/${encodeURIComponent(webhookId)}/deliveries`, { query });
  }

  // ---- Market (the router's view of every provider) -------------------------------------------

  /** Every provider's live price per term, ranked; anonymous. */
  getMarket(): Promise<ResponseOf<'getMarket'>> {
    return this.call('GET', '/market', { auth: 'optional' });
  }

  /** Price history per provider (`slug`) over the last `hours`; anonymous. */
  getMarketHistory(query?: QueryOf<'getMarketHistory'>): Promise<ResponseOf<'getMarketHistory'>> {
    return this.call('GET', '/market/history', { query, auth: 'optional' });
  }

  /** One month of the market in figures (`month=YYYY-MM`); anonymous. */
  getMarketSummary(query?: QueryOf<'getMarketSummary'>): Promise<ResponseOf<'getMarketSummary'>> {
    return this.call('GET', '/market/summary', { query, auth: 'optional' });
  }

  /** Service status: api, database, payments, delivery, supply; anonymous. */
  getStatus(): Promise<ResponseOf<'getStatus'>> {
    return this.call('GET', '/status', { auth: 'none' });
  }

  // ---- Reports --------------------------------------------------------------------------------

  /** The account's orders and spend per day over `from`..`to`. */
  getAccountStats(query?: QueryOf<'getAccountStats'>): Promise<ResponseOf<'getAccountStats'>> {
    return this.call('GET', '/account/stats', { query });
  }

  // ---- Subscription plans ---------------------------------------------------------------------

  /** The plans a subscription can be created on; anonymous. */
  listSubscriptionPlans(): Promise<ResponseOf<'listSubscriptionPlans'>> {
    return this.call('GET', '/subscriptions/plans', { auth: 'none' });
  }

  // ---- Node keys (tener.gy) -------------------------------------------------------------------

  listNodeKeys(): Promise<ResponseOf<'listNodeKeys'>> {
    return this.call('GET', '/node-keys', {});
  }

  createNodeKey(body: RequestBodyOf<'createNodeKey'>): Promise<ResponseOf<'createNodeKey'>> {
    return this.call('POST', '/node-keys', { body });
  }

  revokeNodeKey(id: string): Promise<ResponseOf<'revokeNodeKey'>> {
    return this.call('DELETE', `/node-keys/${encodeURIComponent(id)}`, {});
  }

  // ---- Chain reads ----------------------------------------------------------------------------

  getAddressResources(address: string): Promise<ResponseOf<'getAddressResources'>> {
    return this.call('GET', `/resources/${encodeURIComponent(address)}`, { auth: 'optional' });
  }

  estimateTransferEnergy(
    body: RequestBodyOf<'estimateTransferEnergy'>,
  ): Promise<ResponseOf<'estimateTransferEnergy'>> {
    return this.call('POST', '/estimate/transfer', { body });
  }

  // ---- API keys -------------------------------------------------------------------------------

  listApiKeys(): Promise<ResponseOf<'listApiKeys'>> {
    return this.call('GET', '/api-keys', {});
  }

  /**
   * `scopes` is required and is never defaulted (BUILD.md §3, DECISIONS D-A01/D-A03): a key gets
   * exactly the scopes its creator listed, and a creator may only grant scopes it holds itself.
   */
  createApiKey(
    body: RequestBodyOf<'createApiKey'>,
    options: { bootstrapToken?: string } = {},
  ): Promise<ResponseOf<'createApiKey'>> {
    return this.call('POST', '/api-keys', {
      body,
      auth: options.bootstrapToken === undefined ? 'api-key' : 'bootstrap',
      bootstrapToken: options.bootstrapToken,
    });
  }

  updateApiKey(
    keyId: string,
    body: RequestBodyOf<'updateApiKey'>,
  ): Promise<ResponseOf<'updateApiKey'>> {
    return this.call('PATCH', `/api-keys/${encodeURIComponent(keyId)}`, { body });
  }

  deleteApiKey(keyId: string): Promise<ResponseOf<'deleteApiKey'>> {
    return this.call('DELETE', `/api-keys/${encodeURIComponent(keyId)}`, {});
  }

  // ---- helpers --------------------------------------------------------------------------------

  /**
   * Poll one order until it settles. `201` from `createOrder` means accepted and paid for, not
   * delivered — delivery is a chain event and arrives seconds later, so either subscribe to
   * `order.confirmed` or wait here.
   *
   * A timeout does NOT cancel anything: the order is still whatever the api last said, which is
   * why `TenergyTimeoutError.last` carries it.
   */
  async waitForOrder(orderId: string, options: WaitForOrderOptions = {}): Promise<Order> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const until = new Set<string>(options.until ?? SETTLED_ORDER_STATUSES);
    const deadline = this.now() + timeoutMs;

    let last: Order | undefined;
    for (;;) {
      last = (await this.getOrder(orderId)) as Order;
      if (until.has(last.status)) return last;
      if (this.now() >= deadline) {
        throw new TenergyTimeoutError(
          `Order ${orderId} was still ${last.status} after ${timeoutMs} ms`,
          { waitedMs: timeoutMs, last },
        );
      }
      await this.sleep(pollIntervalMs);
    }
  }

  /**
   * The whole signup path in one call: challenge → sign → verify → create account → deposit
   * address. `signMessage` is the caller's: the platform never sees a private key, so whatever
   * holds the key (a wallet, a KMS, TronLink) signs the returned `message` and hands back the
   * signature.
   *
   * The account starts `unfunded` — orders need a confirmed deposit, an API key does not — so what
   * comes back is the address to send TRX to and the minimum that counts as a deposit.
   */
  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    const purpose = input.purpose ?? 'signup';
    const challenge = await this.createAccountChallenge({ address: input.address, purpose });
    const signature = await input.signMessage(challenge.message);
    const verified = await this.verifyAccountChallenge({
      address: input.address,
      nonce: challenge.nonce,
      signature,
    });
    const bootstrapToken = verified.bootstrap_token;

    const account = await this.createAccount(
      {
        address: input.address,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.email === undefined ? {} : { email: input.email }),
      },
      { bootstrapToken },
    );
    const deposit = await this.getSignupDepositAddress(bootstrapToken, { currency: 'TRX' });

    return { challenge, bootstrapToken, account, deposit };
  }

  // ---- the one request path -------------------------------------------------------------------

  private async call<Op extends OperationId>(
    method: string,
    path: string,
    options: CallOptions<Op>,
  ): Promise<ResponseOf<Op>> {
    const query = encodeQuery(options.query);
    const body = options.body === undefined ? '' : JSON.stringify(options.body);
    const url = `${this.baseUrl}${path}${query === '' ? '' : `?${query}`}`;
    // The signed path is the api's route, including `/v1` — never the bare `path` argument, which
    // is relative to the server URL.
    const signedPath = pathOf(url);
    const retries = IDEMPOTENT_METHODS.has(method.toUpperCase()) ? this.retry.maxRetries : 0;

    let attempt = 0;
    for (;;) {
      // A fresh timestamp and therefore a fresh signature on EVERY attempt: a replayed signature
      // is refused with 1009 even while its timestamp is still inside the skew window.
      const headers = await this.headersFor(method, signedPath, query, body, options);
      try {
        const response = await this.send(url, method, headers, body);
        this.onResponse?.({
          method,
          path: signedPath,
          status: response.status,
          requestId: response.headers.get('x-request-id'),
          requestBody: body,
        });
        const text = await response.text();
        if (response.status >= 200 && response.status < 300) {
          return (text === '' ? undefined : parseJson(text, response.status)) as ResponseOf<Op>;
        }
        const error = toApiError(response, text);
        if (attempt < retries && shouldRetryStatus(response.status, error)) {
          attempt += 1;
          const retryAfter = error instanceof TenergyApiError ? error.retryAfterSeconds : null;
          await this.sleep(this.backoff(attempt, retryAfter));
          continue;
        }
        throw error;
      } catch (caught) {
        if (caught instanceof TenergyApiError || caught instanceof TenergyTransportError) {
          if (caught instanceof TenergyTransportError && attempt < retries) {
            attempt += 1;
            await this.sleep(this.backoff(attempt, null));
            continue;
          }
          throw caught;
        }
        const transport = new TenergyTransportError(
          `${method} ${signedPath} failed: ${messageOf(caught)}`,
          { cause: caught },
        );
        if (attempt < retries) {
          attempt += 1;
          await this.sleep(this.backoff(attempt, null));
          continue;
        }
        throw transport;
      }
    }
  }

  private async headersFor<Op extends OperationId>(
    method: string,
    signedPath: string,
    query: string,
    body: string,
    options: CallOptions<Op>,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
      ...this.extraHeaders,
    };
    if (body !== '') headers['content-type'] = 'application/json';
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

    const auth = options.auth ?? 'api-key';
    if (auth === 'bootstrap') {
      if (options.bootstrapToken === undefined) {
        throw new TypeError('This call needs a bootstrap token (abt_…)');
      }
      headers['authorization'] = `Bearer ${options.bootstrapToken}`;
      return headers;
    }
    if (auth === 'none') return headers;
    if (auth === 'optional' && (this.apiKey === undefined || this.apiSecret === undefined)) return headers;

    if (this.apiKey === undefined || this.apiSecret === undefined) {
      throw new TypeError(
        'TenergyClient: apiKey and apiSecret are required for authenticated calls; construct the client with both, or use the bootstrap flow',
      );
    }
    const timestamp = apiTimestamp(this.now());
    headers['x-api-key'] = this.apiKey;
    headers['x-api-timestamp'] = timestamp;
    headers['x-api-sign'] = await signRequest(this.apiSecret, {
      timestamp,
      method,
      path: signedPath,
      query,
      body,
    });
    return headers;
  }

  private async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        ...(body === '' ? {} : { body }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private backoff(attempt: number, retryAfterSeconds: number | null): number {
    if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
      return Math.min(retryAfterSeconds * 1_000, this.retry.maxDelayMs);
    }
    return Math.min(this.retry.baseDelayMs * 2 ** (attempt - 1), this.retry.maxDelayMs);
  }
}

export interface BootstrapInput {
  address: string;
  /** Signs the challenge message with the address's key. The platform never sees the key. */
  signMessage: (message: string) => Promise<string> | string;
  purpose?: components['schemas']['AccountChallengeRequest']['purpose'];
  label?: string;
  email?: string;
}

export interface BootstrapResult {
  challenge: ResponseOf<'createAccountChallenge'>;
  /** `abt_…`, fifteen minutes, four operations. Keep it to create the first API key. */
  bootstrapToken: string;
  account: ResponseOf<'createAccount'>;
  deposit: ResponseOf<'getSignupDepositAddress'>;
}

// ---- free functions ----------------------------------------------------------------------------

/**
 * The query string, in the order the caller's object lists its keys — and that exact string is
 * what gets signed AND what gets sent, so there is no possibility of the two disagreeing.
 * Arrays repeat the key, which is what the api's `status=a&status=b` filters expect.
 */
export function encodeQuery(query: unknown): string {
  if (query === undefined || query === null) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(entry))}`);
      }
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/** The path the api routes on, taken from the absolute URL so `baseUrl`'s prefix is included. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const mark = url.indexOf('?');
    return mark === -1 ? url : url.slice(0, mark);
  }
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TenergyTransportError('The api answered with a body that is not JSON', {
      httpStatus: status,
      bodyExcerpt: text.slice(0, 512),
      cause: error,
    });
  }
}

function toApiError(
  response: { status: number; headers: { get(name: string): string | null } },
  text: string,
): TenergyApiError | TenergyTransportError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // A proxy's HTML 502, a gateway timeout page: not the api speaking, so not an api error.
    return new TenergyTransportError(`HTTP ${response.status} with a non-JSON body`, {
      httpStatus: response.status,
      bodyExcerpt: text.slice(0, 512),
    });
  }
  if (!isErrorEnvelope(parsed)) {
    return new TenergyTransportError(`HTTP ${response.status} without an error envelope`, {
      httpStatus: response.status,
      bodyExcerpt: text.slice(0, 512),
    });
  }
  const header = response.headers.get('retry-after');
  const retryAfterSeconds = header === null ? null : Number.parseInt(header, 10);
  return new TenergyApiError({
    envelope: parsed,
    httpStatus: response.status,
    retryAfterSeconds:
      retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
  });
}

/**
 * Retry a 429 and the 5xx family, and anything the api itself flagged `retryable` — and nothing
 * else. A 4xx that is not flagged is a request that will fail identically forever.
 */
function shouldRetryStatus(
  status: number,
  error: TenergyApiError | TenergyTransportError,
): boolean {
  if (status === 429 || status >= 500) return true;
  return error instanceof TenergyApiError && error.retryable;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
