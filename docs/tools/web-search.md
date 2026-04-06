---
summary: "Web search and URL fetch tools — search the web and extract content from pages."
read_when:
  - Configuring web search
  - Understanding URL fetching capabilities
  - Setting up a search API key
title: "Web Search & Fetch"
---

# Web Search & Fetch

Two tools for retrieving information from the web: `web_search` for searching and `web_fetch` for extracting content from specific URLs.

## web_search

Search the web for current information using the configured search provider.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | The search query |
| `maxResults` | number | 5 | Maximum results to return |

### Returns

An array of search results, each with:
- `title` — Page title
- `url` — Page URL
- `snippet` — Brief excerpt from the page

### Search providers

ChromeClaw supports two search modes:

- **Tavily API** — Requires a Tavily API key configured in settings. Provides high-quality structured results.
- **Browser-based** — Falls back to browser search when no API key is configured. Uses CAPTCHA resilience and fallback query simplification.

### Caching

Results are cached for 5 minutes by `provider:query:maxResults`. Only non-empty results are cached.

---

## web_fetch

Fetch and extract content from a URL with multiple extraction modes.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | (required) | URL to fetch |
| `method` | `GET` \| `POST` | `GET` | HTTP method |
| `headers` | object | — | Custom request headers |
| `body` | string | — | Request body for POST |
| `extractMode` | `text` \| `html` \| `binary` | `text` | Content extraction mode |
| `maxChars` | number | 30,000 | Maximum characters to return |

### Extraction modes

- **text** — Converts HTML to plain text with entity decoding. Best for reading articles and documentation.
- **html** — Returns raw HTML. Useful when you need to inspect page structure.
- **binary** — Returns base64-encoded data URIs. Used for downloading images and other binary files.

### Returns

| Field | Description |
|-------|-------------|
| `text` | Extracted content |
| `title` | Page title (if available) |
| `status` | HTTP status code |
| `mimeType` | Response MIME type |
| `sizeBytes` | Response size |
| `isBase64` | Whether content is base64-encoded |
| `error` | Error message (if failed) |
| `browserFallback` | Whether browser fallback was used |

### Browser fallback

When a fetch fails due to CORS or network errors, ChromeClaw automatically tries a browser fallback:

1. Opens a background tab with the URL
2. Waits for the page to load (15 second timeout)
3. Extracts `innerText` via the scripting API
4. Closes the tab

### Caching

Results are cached for 5 minutes by `method:url:extractMode:maxChars`. POST requests skip the cache.
