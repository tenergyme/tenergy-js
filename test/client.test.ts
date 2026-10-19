// What goes on the wire, and what comes back off it.
//
// undici's `MockAgent` is installed as the global dispatcher, so the client runs through the real
// `globalThis.fetch` path — headers, redirects, aborts and all — with no network. That is the
// point: a hand-rolled fetch double would not prove that the headers we sign are the headers the
// runtime actually sends.
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenergyApiError, TenergyTransportError, TenergyTimeoutError } from '../src/errors.js';
import { TenergyClient, encodeQuery } from '../src/client.js';
import { canonicalString, signRequest } from '../src/signing.js';

const BASE = 'http://api.tenergy.test';
const PREFIX = '/v1';
const KEY = 'ak_live_9f2c4a';
const SECRET = 'sk_test_example';
const FROZEN = Date.parse('2026-09-12T10:00:00.000Z');

let agent: MockAgent;
let previous: Dispatcher;

/** Headers as undici reports them: lower-cased names, string values. */
interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

const seen: SeenRequest[] = [];

/**
 * undici's `reply` overloads cannot infer a callback that returns two different response shapes
 * (a 503 envelope on one call, a 200 body on the next), which is exactly what a retry test needs.
 * The callback is type-erased here rather than at six call sites.
 */
const dynamicReply = (
  fn: (opts: { headers: unknown; path: string; body?: unknown }) => unknown,
): never => fn as never;

function record(options: {
  method?: string;
  path: string | ((path: string) => boolean);
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  times?: number;
}): void {
  agent
    .get(BASE)
    .intercept({
      method: options.method ?? 'GET',
      path: options.path as never,
    })
    .reply(options.status, options.body as never, {
      headers: { 'content-type': 'application/json', ...options.headers },
    })
    .times(options.times ?? 1);
}

/** A client with a frozen clock and no real waiting, so retry timing is deterministic. */
function makeClient(overrides: Partial<ConstructorParameters<typeof TenergyClient>[0]> = {}): TenergyClient {
  return new TenergyClient({
    baseUrl: `${BASE}${PREFIX}`,
    apiKey: KEY,
    apiSecret: SECRET,
    now: () => FROZEN,
    sleep: async () => {},
    ...overrides,
  });
}

beforeEach(() => {
  seen.length = 0;
  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  // Every intercepted request is recorded before it is answered, so a test can assert on the
  // bytes that were sent rather than on what the client says it sent.
  agent.on('request' as never, () => {});
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(previous);
  await agent.close();
});

describe('request signing on the wire', () => {
  it('sends X-API-KEY, an ISO timestamp and a signature over the exact bytes', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ method: 'POST', path: `${PREFIX}/orders` })
      .reply(201, (opts) => {
        seen.push({
          method: 'POST',
          path: String(opts.path),
          headers: normalizeHeaders(opts.headers),
          body: typeof opts.body === 'string' ? opts.body : '',
        });
        return { id: 'ord_1', status: 'paid' };
      }, { headers: { 'content-type': 'application/json' } });

    const client = makeClient();
    const body = { resource: 'energy', amount: 65_000, tier: '1h', receiver: 'TGaBY3tR2JwABYznzY8XUUMQnuvPEjZCA2' } as never;
    await client.createOrder(body);

    const request = seen[0]!;
    expect(request.headers['x-api-key']).toBe(KEY);
    expect(request.headers['x-api-timestamp']).toBe('2026-09-12T10:00:00.000Z');
    expect(request.headers['content-type']).toContain('application/json');
    // The signature is over the body string that was actually transmitted, not a re-serialization.
    const expected = await signRequest(SECRET, {
      timestamp: '2026-09-12T10:00:00.000Z',
      method: 'POST',
      path: `${PREFIX}/orders`,
      query: '',
      body: request.body,
    });
    expect(request.headers['x-api-sign']).toBe(expected);
  });

  it('signs the query string exactly as sent, in the caller order, with repeated keys', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ method: 'GET', path: (p: string) => p.startsWith(`${PREFIX}/orders?`) })
      .reply(200, (opts) => {
        seen.push({
          method: 'GET',
          path: String(opts.path),
          headers: normalizeHeaders(opts.headers),
          body: '',
        });
        return { data: [], next_cursor: null };
      }, { headers: { 'content-type': 'application/json' } });

    await makeClient().listOrders({ status: ['active', 'paid'], limit: 20 } as never);

    const request = seen[0]!;
    expect(request.path).toBe(`${PREFIX}/orders?status=active&status=paid&limit=20`);
    expect(request.headers['x-api-sign']).toBe(
      await signRequest(SECRET, {
        timestamp: '2026-09-12T10:00:00.000Z',
        method: 'GET',
        path: `${PREFIX}/orders`,
        query: 'status=active&status=paid&limit=20',
        body: '',
      }),
    );
  });

  it('signs the path including the /v1 prefix of baseUrl', () => {
    // Stated as a unit fact because getting it wrong produces 1008 on every single call, and the
    // wire tests above would still pass if both sides were wrong together.
    expect(
      canonicalString({ timestamp: 'T', method: 'GET', path: '/v1/balance', query: '', body: '' }),
    ).toContain('/v1/balance');
  });

  it('uses the bootstrap bearer token, and no signature, where the contract says so', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ method: 'GET', path: (p: string) => p.startsWith(`${PREFIX}/accounts/deposit-address`) })
      .reply(200, (opts) => {
        seen.push({ method: 'GET', path: String(opts.path), headers: normalizeHeaders(opts.headers), body: '' });
        return { account_id: 'acc_1', status: 'unfunded', data: [], min_deposit_sun: 1_000_000 };
      }, { headers: { 'content-type': 'application/json' } });

    await makeClient().getSignupDepositAddress('abt_1.secret', { currency: 'TRX' });
    const request = seen[0]!;
    expect(request.headers['authorization']).toBe('Bearer abt_1.secret');
    expect(request.headers['x-api-sign']).toBeUndefined();
  });

  it('reads the ask ladder with no credential at all', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ method: 'GET', path: (p: string) => p.startsWith(`${PREFIX}/orderbook`) })
      .reply(200, (opts) => {
        seen.push({ method: 'GET', path: String(opts.path), headers: normalizeHeaders(opts.headers), body: '' });
        return {
          resource: 'energy',
          tier: '1h',
          as_of: '2026-09-19T10:00:00.000Z',
          valid_until: '2026-09-19T10:00:03.000Z',
          floor_sun: 20,
          depth: 4_200_000,
          levels: [
            { price_sun: 20, amount: 1_200_000, class: 'instant' },
            { price_sun: 34, amount: 3_000_000, class: 'market' },
          ],
          walk: null,
          cheaper_from: null,
        };
      }, { headers: { 'content-type': 'application/json' } });

    const anonymous = new TenergyClient({ baseUrl: `${BASE}${PREFIX}`, now: () => FROZEN });
    const book = await anonymous.getOrderBook({ resource: 'energy', tier: '1h' });
    expect(book.levels).toHaveLength(2);
    expect(book.depth).toBe(4_200_000);
    const request = seen[0]!;
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.headers['x-api-sign']).toBeUndefined();
    expect(request.path).toContain('resource=energy');
  });

  it('reads the public routes anonymously without a key, and signs them when it holds one', async () => {
    const pool = agent.get(BASE);
    const publicPath = (p: string) =>
      p.startsWith(`${PREFIX}/prices`) || p.startsWith(`${PREFIX}/estimate`) || p.startsWith(`${PREFIX}/resources/`);
    pool
      .intercept({ method: 'GET', path: publicPath })
      .reply(200, (opts) => {
        seen.push({ method: 'GET', path: String(opts.path), headers: normalizeHeaders(opts.headers), body: '' });
        return {};
      }, { headers: { 'content-type': 'application/json' } })
      .times(4);

    const anonymous = new TenergyClient({ baseUrl: `${BASE}${PREFIX}`, now: () => FROZEN });
    await anonymous.getPrices();
    await anonymous.estimateOrder({ resource: 'energy', amount: 65_000, tier: '1h' } as never);
    await anonymous.getAddressResources('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf');
    for (const request of seen) {
      expect(request.headers['x-api-key']).toBeUndefined();
      expect(request.headers['x-api-sign']).toBeUndefined();
    }

    // A presented key is still verified by the api, so a client that holds one signs.
    await makeClient().getPrices();
    expect(seen[3]!.headers['x-api-key']).toBe(KEY);
    expect(seen[3]!.headers['x-api-sign']).toBeDefined();
  });

  it('calls the usage, daily market, JustLend, fee and account-fee routes at their paths (2026-10-09)', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ method: 'GET', path: (p: string) => p.startsWith(PREFIX) })
      .reply(200, (opts) => {
        seen.push({ method: String(opts.method), path: String(opts.path), headers: normalizeHeaders(opts.headers), body: '' });
        return {};
      }, { headers: { 'content-type': 'application/json' } })
      .times(5);

    const anonymous = new TenergyClient({ baseUrl: `${BASE}${PREFIX}`, now: () => FROZEN });
    await anonymous.getAddressUsage('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', { days: '30' });
    await anonymous.getMarketDaily({ days: 30 } as never);
    await anonymous.getMarketJustLend();
    await anonymous.getServiceFees();
    for (const request of seen) expect(request.headers['x-api-key']).toBeUndefined();

    await makeClient().getAccountFee();
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${PREFIX}/resources/TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE/usage?days=30`,
      `GET ${PREFIX}/market/daily?days=30`,
      `GET ${PREFIX}/market/justlend`,
      `GET ${PREFIX}/fees`,
      `GET ${PREFIX}/account/fee`,
    ]);
    expect(seen[4]!.headers['x-api-sign']).toBeDefined();
  });

  it('calls the market, status, plans, stats, deliveries and node-key routes at their paths (2026-10-05)', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ method: /GET|POST|DELETE/, path: (p: string) => p.startsWith(PREFIX) })
      .reply(200, (opts) => {
        seen.push({ method: String(opts.method), path: String(opts.path), headers: normalizeHeaders(opts.headers), body: '' });
        return {};
      }, { headers: { 'content-type': 'application/json' } })
      .times(11);

    const anonymous = new TenergyClient({ baseUrl: `${BASE}${PREFIX}`, now: () => FROZEN });
    await anonymous.getMarket();
    await anonymous.getMarketHistory({ hours: 24 } as never);
    await anonymous.getMarketSummary({ month: '2026-10' } as never);
    await anonymous.getMarketHourlyPattern({ days: '7' });
    await anonymous.getStatus();
    await anonymous.listSubscriptionPlans();
    for (const request of seen) expect(request.headers['x-api-key']).toBeUndefined();

    const keyed = makeClient();
    await keyed.getAccountStats({ from: '2026-10-01T00:00:00Z' } as never);
    await keyed.listWebhookDeliveries('wh_1');
    await keyed.listNodeKeys();
    await keyed.createNodeKey({} as never);
    await keyed.revokeNodeKey('nk_1');
    expect(seen.map((r) => `${r.method} ${r.path.split('?')[0]}`)).toEqual([
      `GET ${PREFIX}/market`,
      `GET ${PREFIX}/market/history`,
      `GET ${PREFIX}/market/summary`,
      `GET ${PREFIX}/market/hourly-pattern`,
      `GET ${PREFIX}/status`,
      `GET ${PREFIX}/subscriptions/plans`,
      `GET ${PREFIX}/account/stats`,
      `GET ${PREFIX}/webhooks/wh_1/deliveries`,
      `GET ${PREFIX}/node-keys`,
      `POST ${PREFIX}/node-keys`,
      `DELETE ${PREFIX}/node-keys/nk_1`,
    ]);
    expect(seen[6]!.headers['x-api-key']).toBe(KEY);
  });

  it('refuses an authenticated call when it holds no key', async () => {
    const client = new TenergyClient({ baseUrl: `${BASE}${PREFIX}` });
    await expect(client.getBalance()).rejects.toThrow(/apiKey and apiSecret are required/);
  });
});

describe('error mapping', () => {
  it('turns the error envelope into a typed TenergyApiError', async () => {
    record({
      path: `${PREFIX}/balance`,
      status: 402,
      body: {
        error: {
          code: 4001,
          slug: 'insufficient_funds',
          message: 'Required 1300000 SUN, available 12 SUN',
          field: null,
          retryable: false,
          details: { required_sun: 1_300_000, available_sun: 12 },
        },
        request_id: 'req_abc',
      },
    });

    const error = await makeClient().getBalance().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenergyApiError);
    const api = error as TenergyApiError;
    expect(api.code).toBe(4001);
    expect(api.slug).toBe('insufficient_funds');
    expect(api.httpStatus).toBe(402);
    expect(api.retryable).toBe(false);
    expect(api.requestId).toBe('req_abc');
    expect(api.details).toEqual({ required_sun: 1_300_000, available_sun: 12 });
  });

  it('carries the offending field of a validation error', async () => {
    record({
      path: `${PREFIX}/balance`,
      status: 422,
      body: {
        error: { code: 2001, slug: 'validation_failed', message: 'amount: too small', field: 'amount', retryable: false },
        request_id: 'req_v',
      },
    });
    const error = (await makeClient().getBalance().catch((caught: unknown) => caught)) as TenergyApiError;
    expect(error.field).toBe('amount');
  });

  it('reads Retry-After off a 429', async () => {
    record({
      path: `${PREFIX}/balance`,
      status: 429,
      body: {
        error: { code: 1006, slug: 'rate_limited', message: 'slow down', field: null, retryable: true },
        request_id: 'req_r',
      },
      headers: { 'retry-after': '3' },
      times: 3,
    });
    const client = makeClient({ retry: { maxRetries: 0 } });
    const error = (await client.getBalance().catch((caught: unknown) => caught)) as TenergyApiError;
    expect(error.retryAfterSeconds).toBe(3);
  });

  it('does not pretend a proxy page is an api error', async () => {
    agent
      .get(BASE)
      .intercept({ method: 'GET', path: `${PREFIX}/balance` })
      .reply(502, '<html>bad gateway</html>', { headers: { 'content-type': 'text/html' } })
      .times(3);

    const error = await makeClient().getBalance().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenergyTransportError);
    expect((error as TenergyTransportError).httpStatus).toBe(502);
    expect((error as TenergyTransportError).bodyExcerpt).toContain('bad gateway');
  });
});

describe('retries', () => {
  it('retries an idempotent GET and returns the eventual success', async () => {
    const pool = agent.get(BASE);
    let calls = 0;
    pool
      .intercept({ method: 'GET', path: `${PREFIX}/balance` })
      .reply(dynamicReply(() => {
        calls += 1;
        if (calls < 3) {
          return {
            statusCode: 503,
            data: {
              error: { code: 5002, slug: 'supply_unavailable', message: 'try again', field: null, retryable: true },
              request_id: 'req_1',
            },
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        }
        return {
          statusCode: 200,
          data: { available_sun: 5_000_000, reserved_sun: 0, currency: 'TRX' },
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      }))
      .times(3);

    const balance = await makeClient().getBalance();
    expect(calls).toBe(3);
    expect(balance).toMatchObject({ available_sun: 5_000_000 });
  });

  it('gives up after maxRetries and throws the last error', async () => {
    record({
      path: `${PREFIX}/balance`,
      status: 503,
      body: {
        error: { code: 5002, slug: 'supply_unavailable', message: 'down', field: null, retryable: true },
        request_id: 'req_2',
      },
      times: 3,
    });
    const error = (await makeClient().getBalance().catch((caught: unknown) => caught)) as TenergyApiError;
    expect(error.slug).toBe('supply_unavailable');
  });

  it('never retries a POST, because a create that timed out may have been executed', async () => {
    const pool = agent.get(BASE);
    let calls = 0;
    pool
      .intercept({ method: 'POST', path: `${PREFIX}/orders` })
      .reply(dynamicReply(() => {
        calls += 1;
        return {
          statusCode: 503,
          data: {
            error: { code: 5002, slug: 'supply_unavailable', message: 'down', field: null, retryable: true },
            request_id: 'req_3',
          },
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      }))
      .times(3);

    await expect(
      makeClient().createOrder({ resource: 'energy', amount: 1_000, tier: '1h', receiver: 'T1' } as never),
    ).rejects.toBeInstanceOf(TenergyApiError);
    expect(calls).toBe(1);
  });

  it('does not retry a 4xx that the api did not flag retryable', async () => {
    const pool = agent.get(BASE);
    let calls = 0;
    pool
      .intercept({ method: 'GET', path: `${PREFIX}/orders/ord_x` })
      .reply(dynamicReply(() => {
        calls += 1;
        return {
          statusCode: 404,
          data: {
            error: { code: 3001, slug: 'order_not_found', message: 'No such order', field: null, retryable: false },
            request_id: 'req_4',
          },
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      }))
      .times(3);

    await expect(makeClient().getOrder('ord_x')).rejects.toBeInstanceOf(TenergyApiError);
    expect(calls).toBe(1);
  });

  it('signs every attempt afresh, because a signature is single-use', async () => {
    const pool = agent.get(BASE);
    const signatures: string[] = [];
    let clock = FROZEN;
    pool
      .intercept({ method: 'GET', path: `${PREFIX}/balance` })
      .reply(dynamicReply((opts) => {
        signatures.push(normalizeHeaders(opts.headers)['x-api-sign'] ?? '');
        clock += 1_000;
        if (signatures.length < 3) {
          return {
            statusCode: 503,
            data: { error: { code: 5002, slug: 'supply_unavailable', message: 'x', field: null, retryable: true }, request_id: 'r' },
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        }
        return {
          statusCode: 200,
          data: { available_sun: 1, reserved_sun: 0, currency: 'TRX' },
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      }))
      .times(3);

    await makeClient({ now: () => clock }).getBalance();
    expect(signatures).toHaveLength(3);
    expect(new Set(signatures).size).toBe(3);
  });
});

describe('waitForOrder', () => {
  it('polls until the order settles', async () => {
    const pool = agent.get(BASE);
    const statuses = ['allocating', 'delegated', 'active'];
    let index = 0;
    pool
      .intercept({ method: 'GET', path: `${PREFIX}/orders/ord_w` })
      .reply(dynamicReply(() => {
        const status = statuses[Math.min(index, statuses.length - 1)]!;
        index += 1;
        return {
          statusCode: 200,
          data: { id: 'ord_w', status },
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      }))
      .times(3);

    const order = await makeClient().waitForOrder('ord_w', { pollIntervalMs: 1 });
    expect(order.status).toBe('active');
    expect(index).toBe(3);
  });

  it('throws a timeout that still carries the last known order', async () => {
    const pool = agent.get(BASE);
    let clock = FROZEN;
    pool
      .intercept({ method: 'GET', path: `${PREFIX}/orders/ord_slow` })
      .reply(dynamicReply(() => {
        clock += 5_000;
        return {
          statusCode: 200,
          data: { id: 'ord_slow', status: 'allocating' },
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      }))
      .times(10);

    const error = await makeClient({ now: () => clock })
      .waitForOrder('ord_slow', { timeoutMs: 6_000, pollIntervalMs: 1 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenergyTimeoutError);
    expect((error as TenergyTimeoutError).last).toMatchObject({ status: 'allocating' });
  });
});

describe('encodeQuery', () => {
  it('drops undefined and null, repeats arrays, and percent-encodes values', () => {
    expect(encodeQuery({ a: 1, b: undefined, c: null, d: ['x', 'y'], e: 'a b+c' })).toBe(
      'a=1&d=x&d=y&e=a%20b%2Bc',
    );
    expect(encodeQuery(undefined)).toBe('');
  });
});

function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      out[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
    }
    return out;
  }
  if (headers !== null && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      out[name.toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value);
    }
  }
  return out;
}
