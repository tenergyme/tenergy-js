// Request signing, byte for byte what the API verifies:
//
//     canonical_string = timestamp + METHOD + path + query + body
//     X-API-SIGN       = base64(HMAC_SHA256(api_secret, canonical_string))
//
// `query` is `''` or `'?'` followed by the raw query string EXACTLY as sent — not re-ordered and
// not re-encoded, so the client signs the bytes it is about to transmit. `body` is the raw
// request body as UTF-8, `''` when there is none.
//
// WHY THIS IS A COPY and not an import. The reference implementation is
// the API's own signer (node:crypto). This one uses WebCrypto (`globalThis.crypto.subtle`),
// so the package runs unchanged on Node 22+, Bun, Deno, Cloudflare Workers and browsers with no
// dependency — the price is that every HMAC here is async. The two implementations are pinned
// together by `test/signing.test.ts`, which signs the same corpus with both and fails on any
// divergence — a divergence would otherwise show up as `1008 invalid_signature` in production.

const encoder = new TextEncoder();

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  let binary = '';
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface CanonicalRequest {
  /** The exact value of the `X-API-TIMESTAMP` header. */
  timestamp: string;
  method: string;
  /** Request path including the `/v1` prefix, percent-encoded exactly as on the wire. */
  path: string;
  /** Raw query string without the `?`, or an empty string. */
  query: string;
  /** Raw request body, `''` for a request without one. */
  body: string;
}

export function canonicalString(request: CanonicalRequest): string {
  const query = request.query === '' ? '' : `?${request.query}`;
  return `${request.timestamp}${request.method.toUpperCase()}${request.path}${query}${request.body}`;
}

export function signRequest(secret: string, request: CanonicalRequest): Promise<string> {
  return hmacSha256Base64(secret, canonicalString(request));
}

/** Split a URL's path-and-query into the two parts the canonical string wants. */
export function splitUrl(url: string): { path: string; query: string } {
  const mark = url.indexOf('?');
  if (mark === -1) return { path: url, query: '' };
  return { path: url.slice(0, mark), query: url.slice(mark + 1) };
}

/** `X-API-TIMESTAMP`: ISO 8601 UTC with milliseconds, which is what the api parses. */
export function apiTimestamp(atMs: number): string {
  return new Date(atMs).toISOString();
}

/**
 * The webhook signature of `docs/api/webhooks.md`, so a customer can verify a delivery with the
 * same package that made the call:
 *
 *     X-API-SIGN = base64(HMAC_SHA256(endpoint_secret, X-API-TIMESTAMP + '.' + raw_body))
 *
 * `rawBody` must be the bytes as received, never a re-serialization of the parsed object.
 */
export function webhookSignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
  return hmacSha256Base64(secret, `${timestamp}.${rawBody}`);
}

/** Constant-time-ish comparison for a webhook signature check. */
export async function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const expected = await webhookSignature(secret, timestamp, rawBody);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
