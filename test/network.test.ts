// Which API a client talks to: mainnet by default, Nile by one option, anything else by baseUrl.
import { describe, expect, it } from 'vitest';
import { TENERGY_API_URLS, TenergyClient } from '../src/client.js';

const noFetch = (async () => {
  throw new Error('no request in this suite');
}) as never;

describe('network', () => {
  it('talks to mainnet when nothing is said', () => {
    const client = new TenergyClient({ fetch: noFetch });
    expect(client.network).toBe('mainnet');
    expect(client.baseUrl).toBe('https://api.tenergy.me/v1');
  });

  it("talks to the Nile sandbox with { network: 'nile' }", () => {
    const client = new TenergyClient({ network: 'nile', fetch: noFetch });
    expect(client.network).toBe('nile');
    expect(client.baseUrl).toBe(TENERGY_API_URLS.nile);
    expect(TENERGY_API_URLS.nile).toBe('https://api-nile.tenergy.me/v1');
  });

  it('lets baseUrl point anywhere else, and then names no network', () => {
    const client = new TenergyClient({ baseUrl: 'http://localhost:3000/v1/', fetch: noFetch });
    expect(client.network).toBeNull();
    expect(client.baseUrl).toBe('http://localhost:3000/v1');
  });

  it('says at construction when a key belongs to the other network', () => {
    expect(() => new TenergyClient({ apiKey: 'ak_test_x', apiSecret: 's', fetch: noFetch })).toThrow(/network: 'nile'/);
    expect(
      () => new TenergyClient({ network: 'nile', apiKey: 'ak_live_x', apiSecret: 's', fetch: noFetch }),
    ).toThrow(/mainnet/);
    // A self-hosted API can issue either kind; the check only guards the two public hosts.
    expect(
      () => new TenergyClient({ baseUrl: 'http://localhost/v1', apiKey: 'ak_test_x', apiSecret: 's', fetch: noFetch }),
    ).not.toThrow();
  });

  it('refuses a network it does not know', () => {
    expect(() => new TenergyClient({ network: 'shasta' as never, fetch: noFetch })).toThrow(/mainnet' or 'nile/);
  });
});

describe('onResponse', () => {
  it('reports every answer with its status and request id', async () => {
    const seen: Array<{ status: number; path: string; requestId: string | null }> = [];
    const client = new TenergyClient({
      baseUrl: 'http://localhost/v1',
      fetch: (async () => ({
        status: 200,
        headers: { get: (name: string) => (name === 'x-request-id' ? 'req_1' : null) },
        text: async () => '{"data":[]}',
      })) as never,
      onResponse: (info) => seen.push({ status: info.status, path: info.path, requestId: info.requestId }),
    });
    await client.getPrices();
    expect(seen).toEqual([{ status: 200, path: '/v1/prices', requestId: 'req_1' }]);
  });

  it('carries the request body, so parallel creates can be told apart', async () => {
    const bodies: string[] = [];
    const client = new TenergyClient({
      baseUrl: 'http://localhost/v1',
      apiKey: 'ak_test_x',
      apiSecret: 'sk_test_x',
      fetch: (async () => ({ status: 200, headers: { get: () => null }, text: async () => '{"id":"ord_1"}' })) as never,
      onResponse: (info) => bodies.push(info.requestBody),
    });
    await client.createOrder({ resource: 'energy', amount: 65_000, tier: '1h', receiver: 'T1', client_order_id: 'c-1' } as never);
    expect(JSON.parse(bodies[0]!).client_order_id).toBe('c-1');
  });
});
