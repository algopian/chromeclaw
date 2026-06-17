/**
 * Convert arbitrary image "content" (as produced by tools or models) into a
 * usable `<img src>` value.
 *
 * Handles three shapes:
 *  - Already-usable sources (`data:` URLs, `http(s)` URLs) — returned unchanged.
 *  - Raw SVG markup — some models (notably the Gemini web provider) "draw" an
 *    image by emitting `<svg ...>...</svg>` as the `create_document` content
 *    instead of generating raster bytes. Encoded as an `image/svg+xml` data URL
 *    so it renders, rather than being mis-tagged as base64 PNG (which produces a
 *    broken/empty image).
 *  - Bare base64 (assumed PNG) — the default for image-generation models.
 */
export const imageContentToSrc = (content: string): string => {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('data:') || trimmed.startsWith('http')) return content;
  // Raw SVG: either a bare `<svg>` root or an XML prolog wrapping one.
  if (/^<svg[\s>]/i.test(trimmed) || (/^<\?xml/i.test(trimmed) && /<svg[\s>]/i.test(trimmed))) {
    return `data:image/svg+xml,${encodeURIComponent(content)}`;
  }
  return `data:image/png;base64,${content}`;
};
