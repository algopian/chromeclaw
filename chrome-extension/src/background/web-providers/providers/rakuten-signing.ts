/**
 * Rakuten AI HMAC-SHA256 request signing utilities.
 *
 * Every REST request requires signed headers (X-Timestamp, X-Nonce, X-Signature)
 * and every WebSocket connection requires signed query params (x-timestamp, x-nonce, x-signature).
 *
 * The signature is computed as: HMAC-SHA256(signingString, key) → Base64URL (no padding).
 *
 * NOTE: This module is also used as the reference implementation for the inline
 * signing logic in content-fetch-main.ts (handleRakuten). Since MAIN world
 * functions are serialized, the signing must be duplicated there.
 */

/** Hardcoded HMAC key from Rakuten AI JS bundle (bx() function). */
const RAKUTEN_HMAC_KEY = '4f0465bfea7761a510dda451ff86a935bf0c8ed6fb37f80441509c64328788c8';

/**
 * Compute HMAC-SHA256 and return the result as a Base64URL-encoded string (no padding).
 */
const hmacSha256Sign = async (message: string, key: string): Promise<string> => {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(signature);
  return btoa(Array.from(bytes, c => String.fromCharCode(c)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
};

/**
 * Build the REST API signature string.
 * Format: {METHOD}{PATH}{sorted_params_concatenated}{timestamp}{nonce}
 *
 * Query params are sorted alphabetically by key and concatenated as `key=value` with no separators.
 * POST body is NOT included — only URL query params.
 */
const buildRestSignatureString = (
  method: string,
  path: string,
  params: Record<string, string>,
  timestamp: string,
  nonce: string,
): string => {
  const sortedParamStr = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('');
  return `${method}${path}${sortedParamStr}${timestamp}${nonce}`;
};

/**
 * Build the WebSocket URL signature string.
 * Format: GET{PATH}{sorted_non_x_params}{timestamp}{nonce}
 *
 * Params starting with `x-` are excluded from signing (they are the signing headers themselves).
 * `accessToken` IS included in the signature.
 */
const buildWsSignatureString = (
  path: string,
  params: Record<string, string>,
  timestamp: string,
  nonce: string,
): string => {
  const nonXParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith('x-')) nonXParams[key] = value;
  }
  const sortedParamStr = Object.keys(nonXParams)
    .sort()
    .map(k => `${k}=${nonXParams[k]}`)
    .join('');
  return `GET${path}${sortedParamStr}${timestamp}${nonce}`;
};

/**
 * Sign a REST API request. Returns the three signing headers.
 */
const signRestRequest = async (
  method: string,
  urlStr: string,
  key: string,
): Promise<{ timestamp: string; nonce: string; signature: string }> => {
  const url = new URL(urlStr);
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, k) => {
    params[k] = value;
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const sigString = buildRestSignatureString(method, url.pathname, params, timestamp, nonce);
  const signature = await hmacSha256Sign(sigString, key);

  return { timestamp, nonce, signature };
};

/**
 * Sign a WebSocket URL. Returns the three signing query params (lowercase x-* keys).
 */
const signWebSocketUrl = async (wsUrl: string, key: string): Promise<Record<string, string>> => {
  const url = new URL(wsUrl);
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, k) => {
    params[k] = value;
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const sigString = buildWsSignatureString(url.pathname, params, timestamp, nonce);
  const signature = await hmacSha256Sign(sigString, key);

  return {
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature,
  };
};

export {
  RAKUTEN_HMAC_KEY,
  hmacSha256Sign,
  buildRestSignatureString,
  buildWsSignatureString,
  signRestRequest,
  signWebSocketUrl,
};
