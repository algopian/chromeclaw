/**
 * GLM request signing — MD5 signature generation for chatglm.cn and chat.z.ai.
 * Both providers require X-Sign, X-Nonce, X-Timestamp headers.
 * Signature = MD5(timestamp-nonce-secret) where timestamp has a checksum digit.
 */

// Public client-side signing constant — extracted from GLM's web frontend JS bundle.
// Not a private server secret; all GLM web clients embed the same value.
const GLM_SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';

// Stable device ID persisted across requests to avoid triggering rate limits.
const GLM_DEVICE_ID = crypto.randomUUID();

const generateGlmSign = (): { timestamp: string; nonce: string; sign: string } => {
  const now = Date.now();
  const digits = now.toString();
  const len = digits.length;
  const digitArr = digits.split('').map(Number);
  const sum = digitArr.reduce((acc, v) => acc + v, 0) - digitArr[len - 2];
  const checkDigit = sum % 10;
  const timestamp = digits.substring(0, len - 2) + checkDigit + digits.substring(len - 1);
  const nonce = crypto.randomUUID().replace(/-/g, '');

  // MD5 via SubtleCrypto is async — use a simple sync approach instead.
  // The sign is computed synchronously in the browser extension context.
  // We pre-compute the MD5 using a minimal inline implementation.
  const sign = md5(`${timestamp}-${nonce}-${GLM_SIGN_SECRET}`);
  return { timestamp, nonce, sign };
};

/**
 * Minimal MD5 implementation for GLM request signing.
 * Uses pre-computed K constants to avoid floating-point precision issues.
 */
const md5 = (input: string): string => {
  // Pre-computed K[i] = floor(2^32 * abs(sin(i+1))) — avoids Math.sin precision issues
  /* eslint-disable @typescript-eslint/no-loss-of-precision */
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  /* eslint-enable @typescript-eslint/no-loss-of-precision */
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  // Encode string to UTF-8 bytes
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }

  // MD5 padding
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // Append 64-bit length in little-endian
  for (let i = 0; i < 4; i++) bytes.push((bitLen >>> (i * 8)) & 0xff);
  for (let i = 0; i < 4; i++) bytes.push(0); // upper 32 bits (always 0 for short inputs)

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Int32Array(16);
    for (let j = 0; j < 16; j++) {
      w[j] =
        bytes[offset + j * 4] |
        (bytes[offset + j * 4 + 1] << 8) |
        (bytes[offset + j * 4 + 2] << 16) |
        (bytes[offset + j * 4 + 3] << 24);
    }

    let a = a0, b = b0, c = c0, d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16)      { f = (b & c) | (~b & d);     g = i; }
      else if (i < 32) { f = (d & b) | (~d & c);     g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d;               g = (3 * i + 5) % 16; }
      else              { f = c ^ (b | ~d);            g = (7 * i) % 16; }

      const temp = d;
      d = c;
      c = b;
      const sum = ((a + f) | 0) + ((K[i] + w[g]) | 0);
      const rot = S[i];
      b = (b + ((sum << rot) | (sum >>> (32 - rot)))) | 0;
      a = temp;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const hex = (n: number) => {
    const u = n >>> 0;
    return (
      ((u & 0xff).toString(16).padStart(2, '0')) +
      (((u >>> 8) & 0xff).toString(16).padStart(2, '0')) +
      (((u >>> 16) & 0xff).toString(16).padStart(2, '0')) +
      (((u >>> 24) & 0xff).toString(16).padStart(2, '0'))
    );
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
};

/**
 * Refresh GLM access token via the provider's refresh endpoint.
 * Used as the `refreshAuth` hook on GLM provider definitions.
 */
const refreshGlmAuth = async (opts: {
  tabId: number;
  cookies: Record<string, string>;
  baseUrl: string;
}): Promise<Record<string, string> | null> => {
  const refreshToken =
    opts.cookies['chatglm_refresh_token'] || opts.cookies['refresh_token'];
  if (!refreshToken || opts.cookies['chatglm_token']) return null;

  const results = await chrome.scripting.executeScript({
    target: { tabId: opts.tabId },
    func: async (refreshUrl: string, token: string) => {
      try {
        const res = await fetch(refreshUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'App-Name': 'chatglm',
            'X-App-Platform': 'pc',
            'X-App-Version': '0.0.1',
          },
          body: JSON.stringify({}),
          credentials: 'include',
        });
        if (!res.ok) return null;
        const data = await res.json();
        return (
          data?.result?.access_token ??
          data?.result?.accessToken ??
          data?.accessToken ??
          null
        );
      } catch {
        return null;
      }
    },
    args: [`${opts.baseUrl}/chatglm/user-api/user/refresh`, refreshToken],
  });
  const accessToken = results?.[0]?.result as string | null;
  if (accessToken) {
    return { chatglm_token: accessToken };
  }
  return null;
};

export { generateGlmSign, md5, GLM_DEVICE_ID, refreshGlmAuth };
