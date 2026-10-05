# TEnergy SDK for TypeScript

Rent TRON energy from code, so your USDT transfers stop burning TRX. Each order goes to the
cheapest provider available right now and is delegated on chain to the address you name. Your
wallet keys never leave your side.

- **Zero dependencies.** Node 22+, Bun, Deno, Cloudflare Workers, browsers (WebCrypto).
- **Typed from the API contract.** One method per endpoint, request and response types included.
- **Safe by default.** Every request signed, retries only where repeating is harmless, typed errors.

```sh
npm install @tenergy/sdk
```

## Energy for one USDT transfer

```ts
import { TenergyClient } from '@tenergy/sdk';

const client = new TenergyClient({
  apiKey: process.env.TENERGY_KEY!,
  apiSecret: process.env.TENERGY_SECRET!,
});

const order = await client.createOrder({
  resource: 'energy',
  amount: 65_000,               // one USDT transfer to an address that already holds USDT
  tier: '1h',                   // the energy is yours for an hour
  receiver: 'T…',               // who gets the energy: the wallet that will send the USDT
  client_order_id: 'payout-42', // makes a retry safe: same id, same order
});

const delivered = await client.waitForOrder(order.id); // status 'active', delegate_hashes on chain
```

## How much energy to order

| The USDT transfer goes to | Energy |
|---|---|
| an address that already holds USDT | 65,000 |
| an address with zero USDT | 131,000 |
| not sure | `client.estimateTransferEnergy({ from_address, to_address })` → `recommended_amount` |

## Try it on the testnet first

```ts
const client = new TenergyClient({ apiKey, apiSecret, network: 'nile' });
```

Nile is a separate sandbox with `ak_test_` keys and free test TRX and USDT
([faucet](https://nileex.io/join/getJoinPage)); delegations show up on [nile.tronscan.org](https://nile.tronscan.org). Mainnet is the default and takes `ak_live_` keys;
mixing them up fails when the client is built, not on the first order.

## Get a key

In the [dashboard](https://tenergy.me/app), or from code: `client.bootstrap({ address, signMessage })`
signs you up with a TRON wallet signature — your `signMessage` signs, the key stays with you.
A full signup → deposit → order script is in
[tenergy-examples-ts](https://github.com/tenergyme/tenergy-examples-ts).

## Errors and retries

```ts
import { TenergyApiError } from '@tenergy/sdk';

try {
  await client.createOrder(/* … */);
} catch (error) {
  if (error instanceof TenergyApiError && error.slug === 'insufficient_funds') {
    // top up, then repeat with the same client_order_id
  } else throw error;
}
```

Branch on `slug`, never on `message` — [all codes](https://tenergy.me/docs/errors).
Reads are retried with backoff; creates are sent once, so a timed-out create is repeated by you
with the same `client_order_id`.

## Webhooks

Get `order.confirmed` the moment the delegation is on chain instead of polling:

```ts
import { verifyWebhookSignature } from '@tenergy/sdk';

const ok = await verifyWebhookSignature(
  secret, req.headers['x-api-timestamp'], rawBody, req.headers['x-api-sign'],
); // rawBody: the bytes as received, before JSON.parse
```

## Links

[Docs](https://tenergy.me/docs) · [API reference](https://tenergy.me/docs/api/orders) ·
[Examples](https://github.com/tenergyme/tenergy-examples-ts) · [Python SDK](https://pypi.org/project/tenergy/) ·
support@tenergy.me

MIT licensed.
