import { executeBrowser } from './browser';
import {
  normalizeCacheKey,
  readCache,
  writeCache,
  withTimeout,
  readResponseText,
  DEFAULT_CACHE_TTL_MINUTES,
} from './web-shared';
import { createLogger } from '../logging/logger-buffer';
import { toolConfigStorage } from '@extension/storage';
import { Type } from '@sinclair/typebox';
import type { BrowserArgs } from './browser';
import type { CacheEntry } from './web-shared';
import type { WebSearchProviderConfig, BrowserSearchEngine } from '@extension/storage';
import type { Static } from '@sinclair/typebox';

/** Web search only uses non-screenshot browser actions, so the result is always a string. */
const executeBrowserText = async (args: BrowserArgs): Promise<string> => {
  const result = await executeBrowser(args);
  return typeof result === 'string' ? result : JSON.stringify(result);
};

const searchLog = createLogger('tool');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const webSearchSchema = Type.Object({
  query: Type.String({ description: 'The search query' }),
  maxResults: Type.Optional(
    Type.Number({ description: 'Maximum number of results to return', default: 5 }),
  ),
});

type WebSearchArgs = Static<typeof webSearchSchema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const SEARCH_CACHE = new Map<string, CacheEntry<SearchResult[]>>();
const CACHE_TTL_MS = DEFAULT_CACHE_TTL_MINUTES * 60_000;

// ---------------------------------------------------------------------------
// Tavily provider
// ---------------------------------------------------------------------------

interface TavilySearchResponse {
  results?: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}

const runTavilySearch = async (
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<SearchResult[]> => {
  searchLog.trace('[tavily] request', { url: 'https://api.tavily.com/search', query, maxResults });

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
    }),
    signal: withTimeout(30),
  });

  searchLog.trace('[tavily] response', { status: response.status, ok: response.ok });

  if (!response.ok) {
    const body = await readResponseText(response);
    throw new Error(`Tavily Search API error: ${response.status} ${response.statusText} — ${body}`);
  }

  const data = (await response.json()) as TavilySearchResponse;
  const results = data.results ?? [];

  searchLog.trace('[tavily] parsed results', { count: results.length });

  return results.map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
};

// ---------------------------------------------------------------------------
// Browser provider — uses executeBrowser to search via Google/Bing/DuckDuckGo
// ---------------------------------------------------------------------------

/** Build the search URL for a given engine. */
const buildSearchUrl = (engine: BrowserSearchEngine, query: string): string => {
  const q = encodeURIComponent(query);
  switch (engine) {
    case 'google':
      return `https://www.google.com/search?q=${q}`;
    case 'bing':
      return `https://www.bing.com/search?q=${q}`;
    case 'duckduckgo':
      return `https://html.duckduckgo.com/html/?q=${q}`;
  }
};

/**
 * Build a generic, engine-agnostic JS expression that extracts search results
 * from any search engine page.
 *
 * Strategy: Instead of relying on engine-specific CSS class names (which
 * change frequently), we structurally find all external `<a>` links on the
 * page, filter out the search engine's own navigation/infrastructure links,
 * extract the title from the link text (or a heading inside/above the link),
 * and extract a snippet from the nearest parent container's text content.
 */
const getExtractionExpression = (maxResults: number): string => `
  (() => {
    const host = location.hostname;
    const skip = [
      'google.', 'gstatic.', 'googleapis.', 'youtube.com/results',
      'bing.com/aclick', 'bing.com/ck/', 'microsoft.com/en-us/bing',
      'duckduckgo.com', 'duck.com',
      'schema.org', 'w3.org', 'creativecommons.org',
      'accounts.google', 'support.google', 'maps.google',
      'policies.google', 'play.google',
    ];
    const results = [];
    const seen = new Set();

    for (const a of document.querySelectorAll('a[href]')) {
      if (results.length >= ${maxResults}) break;
      try {
        const url = new URL(a.href, location.href);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        if (url.hostname === host) continue;
        if (skip.some(d => url.href.includes(d))) continue;

        const dedup = url.origin + url.pathname;
        if (seen.has(dedup)) continue;
        seen.add(dedup);

        const heading = a.querySelector('h1,h2,h3,h4') || a.closest('h1,h2,h3,h4');
        const title = (heading ? heading.innerText : a.innerText || '').trim();
        if (!title || title.length < 5 || title.startsWith('http')) continue;

        let snippet = '';
        let el = a.parentElement;
        for (let i = 0; i < 5 && el; i++) {
          const text = (el.innerText || '').trim();
          if (text.length > title.length + 20) {
            snippet = text
              .split('\\n')
              .filter(line => line.trim() && !line.includes(title) && !line.startsWith('http'))
              .join(' ')
              .substring(0, 300)
              .trim();
            break;
          }
          el = el.parentElement;
        }

        results.push({ title, url: url.href, snippet });
      } catch (_) {}
    }
    return JSON.stringify(results);
  })()
`;

// ---------------------------------------------------------------------------
// Query sanitization & simplification
// ---------------------------------------------------------------------------

const MAX_QUERY_LENGTH = 200;

/** Sanitize a query to reduce CAPTCHA / "unusual traffic" triggers. */
const sanitizeQuery = (query: string): string => {
  let q = query;
  // Replace smart quotes with regular quotes
  q = q.replace(/[\u201c\u201d\u2018\u2019]/g, '"');
  // Remove excessive quoted phrases (keep max 2)
  let quoteCount = 0;
  q = q.replace(/"[^"]*"/g, match => {
    quoteCount++;
    return quoteCount <= 2 ? match : match.replace(/"/g, '');
  });
  // Truncate to MAX_QUERY_LENGTH at word boundary
  if (q.length > MAX_QUERY_LENGTH) {
    q = q.slice(0, MAX_QUERY_LENGTH).replace(/\s\S*$/, '');
  }
  return q.trim();
};

/** Aggressively simplify a query for retry after initial search fails. */
const simplifyQuery = (query: string): string => {
  let q = query;
  // Remove quotes from all quoted phrases
  q = q.replace(/"[^"]*"/g, match => match.replace(/"/g, ''));
  // Strip special characters (keep word chars, spaces, hyphens)
  q = q.replace(/[^\w\s-]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  // Truncate to ~100 chars at word boundary
  if (q.length > 100) {
    q = q
      .slice(0, 100)
      .replace(/\s\S*$/, '')
      .trim();
  }
  return q;
};

// ---------------------------------------------------------------------------
// Page diagnostics (for debugging CAPTCHA / consent pages)
// ---------------------------------------------------------------------------

const PAGE_DIAGNOSTICS_EXPR = `JSON.stringify({ title: document.title, text: document.body?.innerText?.slice(0, 500) ?? '' })`;

/** Max number of polling attempts for search results to appear in DOM. */
const POLL_MAX_ATTEMPTS = 3;
/** Delay between polling attempts in milliseconds. */
const POLL_INTERVAL_MS = 1000;

/**
 * Poll the tab for search results up to `maxAttempts` times.
 * Returns parsed results on success, or `null` if all attempts returned empty.
 */
const pollForResults = async (
  tabId: number,
  expression: string,
  engine: BrowserSearchEngine,
  maxAttempts: number,
): Promise<SearchResult[] | null> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const evalResult = await executeBrowserText({ action: 'evaluate', tabId, expression });
    searchLog.trace('[browser] evaluate attempt', {
      attempt: attempt + 1,
      rawLength: evalResult.length,
      rawPreview: evalResult.slice(0, 300),
    });

    if (evalResult.startsWith('Error:')) {
      throw new Error(`Browser search extraction failed: ${evalResult}`);
    }

    let parsed: Array<{ title: string; url: string; snippet: string }>;
    try {
      parsed = JSON.parse(evalResult) as Array<{
        title: string;
        url: string;
        snippet: string;
      }>;
    } catch {
      throw new Error(
        `Browser search: failed to parse results from ${engine} — raw output: ${evalResult.slice(0, 200)}`,
      );
    }

    searchLog.trace('[browser] parsed attempt', {
      attempt: attempt + 1,
      resultCount: parsed.length,
    });

    if (parsed.length > 0) {
      return parsed.map(r => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.snippet || '',
      }));
    }
  }
  return null;
};

const runBrowserSearch = async (
  query: string,
  maxResults: number,
  engine: BrowserSearchEngine,
): Promise<SearchResult[]> => {
  const sanitizedQuery = sanitizeQuery(query);
  const searchUrl = buildSearchUrl(engine, sanitizedQuery);
  searchLog.trace('[browser] starting search', {
    engine,
    searchUrl,
    originalQuery: query,
    sanitizedQuery,
  });

  // 1. Open a blank background tab, then navigate (which waits for Page.loadEventFired)
  const openedTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const tabId = openedTab.id ?? null;
  searchLog.trace('[browser] opened background tab', { tabId });
  if (tabId == null) {
    throw new Error('Browser search: failed to open tab — no tab ID returned');
  }

  try {
    // 2. Navigate to search URL — executeBrowser 'navigate' waits for page load
    const navResult = await executeBrowserText({ action: 'navigate', tabId, url: searchUrl });
    searchLog.trace('[browser] navigate result', { navResult: navResult.slice(0, 200) });
    if (navResult.startsWith('Error:')) {
      throw new Error(`Browser search navigation failed: ${navResult}`);
    }

    // 3. Poll for results — search engines render results asynchronously via JS
    //    after Page.loadEventFired, so we retry extraction with a short delay.
    const expression = getExtractionExpression(maxResults);
    const results = await pollForResults(tabId, expression, engine, POLL_MAX_ATTEMPTS);

    if (results) {
      return results;
    }

    // 4. All poll attempts returned empty — collect diagnostics and retry with simplified query
    searchLog.warn('[browser] all poll attempts returned empty', {
      tabId,
      engine,
      attempts: POLL_MAX_ATTEMPTS,
      sanitizedQuery,
    });
    let diagnostics: string | undefined;
    try {
      const diagResult = await executeBrowserText({
        action: 'evaluate',
        tabId,
        expression: PAGE_DIAGNOSTICS_EXPR,
      });
      diagnostics = diagResult;
    } catch {
      // Diagnostics are best-effort
    }

    searchLog.trace('[browser] initial search returned empty, retrying with simplified query', {
      engine,
      sanitizedQuery,
      diagnostics: diagnostics?.slice(0, 500),
    });

    const simplified = simplifyQuery(sanitizedQuery);
    if (simplified === sanitizedQuery || !simplified) {
      // Simplification didn't change anything — no point retrying
      searchLog.trace('[browser] simplified query unchanged, returning empty', { simplified });
      return [];
    }

    // 5. Navigate to new search URL with simplified query
    const retryUrl = buildSearchUrl(engine, simplified);
    searchLog.trace('[browser] retry with simplified query', { simplified, retryUrl });

    const retryNavResult = await executeBrowserText({ action: 'navigate', tabId, url: retryUrl });
    if (retryNavResult.startsWith('Error:')) {
      searchLog.trace('[browser] retry navigation failed', { retryNavResult });
      return [];
    }

    const retryResults = await pollForResults(tabId, expression, engine, POLL_MAX_ATTEMPTS);
    if (retryResults) {
      return retryResults;
    }

    // All retry attempts also returned empty
    searchLog.trace('[browser] retry also returned empty, giving up', {
      engine,
      totalAttempts: POLL_MAX_ATTEMPTS * 2,
    });
    return [];
  } finally {
    // Always close the tab
    searchLog.trace('[browser] closing search tab', { tabId });
    await executeBrowserText({ action: 'close', tabId }).catch(() => {
      // Ignore cleanup errors
    });
  }
};

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

const resolveApiKey = (config: WebSearchProviderConfig): string => {
  switch (config.provider) {
    case 'tavily':
      return config.tavily.apiKey;
    case 'browser':
      return ''; // Browser provider doesn't need an API key
  }
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const executeWebSearch = async (args: WebSearchArgs): Promise<SearchResult[]> => {
  const { query, maxResults: _maxResults } = args;
  const maxResults = _maxResults ?? 5;
  searchLog.trace('[webSearch] execute', { query, maxResults });

  const config = await toolConfigStorage.get();
  const searchConfig = config.webSearchConfig;

  searchLog.trace('[webSearch] resolved config', {
    provider: searchConfig.provider,
    ...(searchConfig.provider === 'browser' ? { engine: searchConfig.browser.engine } : {}),
    ...(searchConfig.provider === 'tavily' ? { hasApiKey: !!searchConfig.tavily.apiKey } : {}),
  });

  // Check cache
  const cacheKey = normalizeCacheKey(`${searchConfig.provider}:${query}:${maxResults}`);
  const cached = readCache(SEARCH_CACHE, cacheKey, CACHE_TTL_MS);
  if (cached) {
    searchLog.trace('[webSearch] cache hit', { cacheKey, resultCount: cached.length });
    return cached;
  }
  searchLog.trace('[webSearch] cache miss', { cacheKey });

  let results: SearchResult[];

  searchLog.trace('[webSearch] dispatching to provider', { provider: searchConfig.provider });

  switch (searchConfig.provider) {
    case 'tavily': {
      const apiKey = resolveApiKey(searchConfig);
      if (!apiKey) {
        throw new Error(
          'Tavily API key not configured. Please set it in Options → Tools → Web Search.',
        );
      }
      results = await runTavilySearch(query, maxResults, apiKey);
      break;
    }
    case 'browser': {
      results = await runBrowserSearch(query, maxResults, searchConfig.browser.engine);
      break;
    }
  }

  searchLog.trace('[webSearch] complete', {
    provider: searchConfig.provider,
    resultCount: results.length,
  });

  // Only cache non-empty results — empty results likely mean the extraction
  // failed (page not loaded, selectors missed, CAPTCHA, etc.) and should
  // not poison the cache for subsequent attempts.
  if (results.length > 0) {
    writeCache(SEARCH_CACHE, cacheKey, results);
  }

  return results;
};

export {
  webSearchSchema,
  executeWebSearch,
  // Exported for testing
  runTavilySearch,
  runBrowserSearch,
  buildSearchUrl,
  getExtractionExpression,
  resolveApiKey,
  sanitizeQuery,
  simplifyQuery,
  SEARCH_CACHE,
};
export type { WebSearchArgs, SearchResult };

// ── Tool registration ──
import type { ToolRegistration } from './tool-registration';
import { jsonFormatResult } from './tool-registration';

const webSearchToolDef: ToolRegistration = {
  name: 'web_search',
  label: 'Web Search',
  description:
    'Search the web for current information using the configured search provider (Tavily API or browser-based search). Use this when the user asks about recent events, news, or information that may not be in your training data.',
  schema: webSearchSchema,
  execute: args => executeWebSearch(args as WebSearchArgs),
  formatResult: jsonFormatResult,
};

export { webSearchToolDef };
