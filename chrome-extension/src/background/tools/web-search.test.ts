import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSearchProviderConfig } from '@extension/storage';

// ---------------------------------------------------------------------------
// Chrome API mocks — must be set up BEFORE importing the module under test
// because browser.ts registers listeners at module load time.
// ---------------------------------------------------------------------------

const mockTabsCreate = vi.fn((opts: { url: string }) =>
  Promise.resolve({ id: 99, title: '', url: opts.url, windowId: 1 }),
);
const mockTabsRemove = vi.fn(() => Promise.resolve());
const mockTabsGet = vi.fn((tabId: number) =>
  Promise.resolve({ id: tabId, title: 'Test', url: 'https://test.com' }),
);

// In-memory chrome.storage.local mock
const storageData: Record<string, unknown> = {};
const storageListeners: Array<(changes: Record<string, unknown>) => void> = [];

Object.defineProperty(globalThis, 'chrome', {
  value: {
    debugger: {
      attach: vi.fn((_t: unknown, _v: string, cb: () => void) => cb()),
      detach: vi.fn((_t: unknown, cb: () => void) => cb()),
      sendCommand: vi.fn((_t: unknown, _m: string, _p: unknown, cb: (r: unknown) => void) =>
        cb({}),
      ),
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(() => Promise.resolve([])),
      create: mockTabsCreate,
      update: vi.fn((tabId: number) =>
        Promise.resolve({ id: tabId, title: 'Updated', windowId: 1 }),
      ),
      remove: mockTabsRemove,
      get: mockTabsGet,
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: { update: vi.fn() },
    scripting: { executeScript: vi.fn(() => Promise.resolve([{ result: '' }])) },
    runtime: { lastError: undefined },
    storage: {
      local: {
        get: vi.fn((keys: string | string[], cb?: (items: Record<string, unknown>) => void) => {
          const result: Record<string, unknown> = {};
          const keyList = typeof keys === 'string' ? [keys] : keys;
          for (const k of keyList) {
            if (k in storageData) result[k] = storageData[k];
          }
          if (cb) cb(result);
          return Promise.resolve(result);
        }),
        set: vi.fn((items: Record<string, unknown>, cb?: () => void) => {
          Object.assign(storageData, items);
          if (cb) cb();
          return Promise.resolve();
        }),
        onChanged: {
          addListener: (fn: (changes: Record<string, unknown>) => void) => {
            storageListeners.push(fn);
          },
          removeListener: vi.fn(),
        },
      },
      session: {
        get: vi.fn((_keys: unknown, cb?: (items: Record<string, unknown>) => void) => {
          if (cb) cb({});
          return Promise.resolve({});
        }),
        set: vi.fn((_items: unknown, cb?: () => void) => {
          if (cb) cb();
          return Promise.resolve();
        }),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
  writable: true,
  configurable: true,
});

// Mock chrome.scripting.executeScript for scriptEvaluate in runBrowserSearch.
const mockExecuteScript = vi.fn(() => Promise.resolve([{ result: '[]' }]));
(chrome.scripting.executeScript as ReturnType<typeof vi.fn>) = mockExecuteScript;

// Mock chrome.tabs.update for retry navigation.
const mockTabsUpdate = vi.fn((tabId: number) =>
  Promise.resolve({ id: tabId, title: 'Updated', windowId: 1 }),
);
(chrome.tabs.update as ReturnType<typeof vi.fn>) = mockTabsUpdate;

// Now it's safe to import
const {
  buildSearchUrl,
  getExtractionExpression,
  resolveApiKey,
  runTavilySearch,
  runBrowserSearch,
  sanitizeQuery,
  simplifyQuery,
  SEARCH_CACHE,
} = await import('./web-search');

// ---------------------------------------------------------------------------
// buildSearchUrl
// ---------------------------------------------------------------------------

describe('buildSearchUrl', () => {
  it('builds Google search URL', () => {
    const url = buildSearchUrl('google', 'test query');
    expect(url).toBe('https://www.google.com/search?q=test%20query');
  });

  it('builds Bing search URL', () => {
    const url = buildSearchUrl('bing', 'test query');
    expect(url).toBe('https://www.bing.com/search?q=test%20query');
  });

  it('builds DuckDuckGo search URL', () => {
    const url = buildSearchUrl('duckduckgo', 'test query');
    expect(url).toBe('https://html.duckduckgo.com/html/?q=test%20query');
  });

  it('encodes special characters', () => {
    const url = buildSearchUrl('google', 'hello world & foo=bar');
    expect(url).toContain('q=hello%20world%20%26%20foo%3Dbar');
  });
});

// ---------------------------------------------------------------------------
// getExtractionExpression
// ---------------------------------------------------------------------------

describe('getExtractionExpression', () => {
  it('includes maxResults limit', () => {
    const expr = getExtractionExpression(5);
    expect(expr).toContain('>= 5');
  });

  it('filters external links by protocol', () => {
    const expr = getExtractionExpression(10);
    expect(expr).toContain("url.protocol !== 'https:'");
    expect(expr).toContain("url.protocol !== 'http:'");
  });

  it('skips search engine infrastructure domains', () => {
    const expr = getExtractionExpression(3);
    expect(expr).toContain('google.');
    expect(expr).toContain('bing.com/aclick');
    expect(expr).toContain('duckduckgo.com');
  });

  it('extracts title from headings or link text', () => {
    const expr = getExtractionExpression(5);
    expect(expr).toContain("a.querySelector('h1,h2,h3,h4')");
    expect(expr).toContain('a.innerText');
  });

  it('walks up DOM for snippet extraction', () => {
    const expr = getExtractionExpression(5);
    expect(expr).toContain('a.parentElement');
    expect(expr).toContain('substring(0, 300)');
  });
});

// ---------------------------------------------------------------------------
// resolveApiKey
// ---------------------------------------------------------------------------

describe('resolveApiKey', () => {
  it('returns tavily API key for tavily provider', () => {
    const config: WebSearchProviderConfig = {
      provider: 'tavily',
      tavily: { apiKey: 'tvly-test123' },
      browser: { engine: 'google' },
    };
    expect(resolveApiKey(config)).toBe('tvly-test123');
  });

  it('returns empty string for browser provider', () => {
    const config: WebSearchProviderConfig = {
      provider: 'browser',
      tavily: { apiKey: 'tvly-test123' },
      browser: { engine: 'google' },
    };
    expect(resolveApiKey(config)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// runTavilySearch
// ---------------------------------------------------------------------------

describe('runTavilySearch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls Tavily API with correct parameters', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        results: [
          { title: 'Result 1', url: 'https://example.com/1', content: 'Snippet 1' },
          { title: 'Result 2', url: 'https://example.com/2', content: 'Snippet 2' },
        ],
      }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    const results = await runTavilySearch('test query', 5, 'tvly-test123');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: 'tvly-test123',
          query: 'test query',
          max_results: 5,
          include_answer: false,
        }),
      }),
    );

    expect(results).toEqual([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2' },
    ]);
  });

  it('throws on non-OK response', async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue('Invalid API key'),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    await expect(runTavilySearch('query', 5, 'bad-key')).rejects.toThrow('Tavily Search API error');
  });

  it('handles empty results', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ results: [] }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    const results = await runTavilySearch('query', 5, 'tvly-key');
    expect(results).toEqual([]);
  });

  it('handles missing results field', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    const results = await runTavilySearch('query', 5, 'tvly-key');
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runBrowserSearch — integration tests with mocked executeBrowser
// ---------------------------------------------------------------------------

describe('runBrowserSearch', () => {
  const mockSearchResults = JSON.stringify([
    { title: 'Seattle Times', url: 'https://seattletimes.com/article', snippet: 'Latest news' },
    { title: 'King5 News', url: 'https://king5.com/story', snippet: 'Breaking story' },
  ]);

  beforeEach(() => {
    mockTabsCreate.mockReset();
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 99, title: '', url: opts.url, windowId: 1, status: 'complete' }),
    );
    mockTabsGet.mockReset();
    mockTabsGet.mockImplementation((tabId: number) =>
      Promise.resolve({ id: tabId, title: 'Test', url: 'https://test.com', status: 'complete' }),
    );
    mockTabsRemove.mockReset();
    mockTabsRemove.mockImplementation(() => Promise.resolve());
    mockExecuteScript.mockReset();
    mockExecuteScript.mockImplementation(() => Promise.resolve([{ result: mockSearchResults }]));
    mockTabsUpdate.mockReset();
    mockTabsUpdate.mockImplementation((tabId: number) =>
      Promise.resolve({ id: tabId, title: 'Updated', windowId: 1 }),
    );
  });

  it('creates tab with search URL, evaluates, and closes (no CDP)', async () => {
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 42, title: '', url: opts.url, windowId: 1, status: 'complete' }),
    );

    await runBrowserSearch('test', 5, 'google');

    // Tab created directly with search URL (not about:blank)
    expect(mockTabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('google.com/search?q=test'), active: false }),
    );
    // Evaluate called via chrome.scripting.executeScript
    expect(mockExecuteScript).toHaveBeenCalled();
    // Tab closed via chrome.tabs.remove
    expect(mockTabsRemove).toHaveBeenCalledWith(42);
  });

  it('creates tab directly with search URL (no about:blank intermediate)', async () => {
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 10, title: '', url: opts.url, windowId: 1, status: 'complete' }),
    );

    await runBrowserSearch('seattle news', 5, 'google');
    expect(mockTabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('google.com/search?q=seattle%20news') }),
    );
  });

  it('returns parsed search results', async () => {
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 1, title: '', url: opts.url, windowId: 1, status: 'complete' }),
    );

    const results = await runBrowserSearch('test', 5, 'google');

    expect(results).toEqual([
      { title: 'Seattle Times', url: 'https://seattletimes.com/article', snippet: 'Latest news' },
      { title: 'King5 News', url: 'https://king5.com/story', snippet: 'Breaking story' },
    ]);
  });

  it('polls when first evaluate returns empty, returns on second attempt', async () => {
    vi.useFakeTimers();
    let evaluateCallCount = 0;
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 5, title: '', url: opts.url, windowId: 1, status: 'complete' }),
    );

    mockExecuteScript.mockImplementation(() => {
      evaluateCallCount++;
      if (evaluateCallCount === 1) return Promise.resolve([{ result: '[]' }]);
      return Promise.resolve([{ result: mockSearchResults }]);
    });

    const promise = runBrowserSearch('test', 5, 'google');
    // Flush the poll delay between attempt 1 and 2
    await vi.advanceTimersByTimeAsync(2000);
    const results = await promise;

    expect(evaluateCallCount).toBe(2);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Seattle Times');
    vi.useRealTimers();
  });

  it('returns empty array after all poll attempts fail (initial + retry)', async () => {
    vi.useFakeTimers();
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 7, title: '', url: opts.url, windowId: 1, status: 'complete' }),
    );

    mockExecuteScript.mockImplementation(() => Promise.resolve([{ result: '[]' }]));

    const promise = runBrowserSearch('test query with "quoted" stuff', 5, 'google');
    // Flush poll delays: 3 initial attempts (2 waits) + retry nav + 3 retry attempts (2 waits)
    await vi.advanceTimersByTimeAsync(10000);
    const results = await promise;

    expect(results).toEqual([]);
    vi.useRealTimers();
  });

  it('always closes the tab even if evaluate throws', async () => {
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 3, title: '', url: opts.url, windowId: 1, status: 'complete' }),
    );

    mockExecuteScript.mockImplementation(() => Promise.resolve([{ result: 'Error: Runtime.evaluate failed' }]));

    await expect(runBrowserSearch('test', 5, 'google')).rejects.toThrow(
      'Browser search extraction failed',
    );
    expect(mockTabsRemove).toHaveBeenCalledWith(3);
  });

  it('always closes the tab even if page load times out', async () => {
    vi.useFakeTimers();
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 4, title: '', url: opts.url, windowId: 1, status: 'loading' }),
    );
    // Tab never completes loading — waitForTabLoad checks chrome.tabs.get first
    mockTabsGet.mockImplementation((tabId: number) =>
      Promise.resolve({ id: tabId, title: 'Test', url: 'https://test.com', status: 'loading' }),
    );

    const promise = runBrowserSearch('test', 5, 'google');
    // Attach a no-op catch handler to prevent unhandled rejection during timer advancement
    const caught = promise.catch(() => {});
    // Advance past the load timeout (15s)
    await vi.advanceTimersByTimeAsync(20000);
    await caught;

    await expect(promise).rejects.toThrow('Page load timed out');
    expect(mockTabsRemove).toHaveBeenCalledWith(4);
    vi.useRealTimers();
  });

  it('throws when tab fails to open', async () => {
    mockTabsCreate.mockImplementation(() =>
      Promise.resolve({ id: undefined, title: '', url: '', windowId: 1 }),
    );

    await expect(runBrowserSearch('test', 5, 'google')).rejects.toThrow(
      'Browser search: failed to open tab',
    );
  });

  it('throws descriptive error when evaluate returns malformed JSON', async () => {
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 6, title: '', url: opts.url, windowId: 1, status: 'complete' }),
    );

    mockExecuteScript.mockImplementation(() => Promise.resolve([{ result: '<html>not json</html>' }]));

    await expect(runBrowserSearch('test', 5, 'google')).rejects.toThrow(
      'Browser search: failed to parse results from google',
    );
  });

  it('uses correct search URL per engine', async () => {
    const createdUrls: string[] = [];
    mockTabsCreate.mockImplementation((opts: { url: string }) => {
      createdUrls.push(opts.url);
      return Promise.resolve({ id: 1, title: '', url: opts.url, windowId: 1, status: 'complete' });
    });

    await runBrowserSearch('weather', 3, 'google');
    await runBrowserSearch('weather', 3, 'bing');
    await runBrowserSearch('weather', 3, 'duckduckgo');

    expect(createdUrls[0]).toContain('google.com/search?q=weather');
    expect(createdUrls[1]).toContain('bing.com/search?q=weather');
    expect(createdUrls[2]).toContain('duckduckgo.com/html/?q=weather');
  });
});

// ---------------------------------------------------------------------------
// Extraction expression — evaluated against mock DOM
// ---------------------------------------------------------------------------

describe('getExtractionExpression evaluated against HTML', () => {
  /**
   * Helper: build a minimal mock DOM environment, set innerHTML, then
   * evaluate the extraction expression using Node's vm module.
   * This avoids needing jsdom as a dependency.
   */
  const evaluateExtraction = (html: string, hostname: string, maxResults = 5): unknown[] => {
    // Build a real DOM fragment using a minimal approach:
    // We create mock elements from an HTML string by parsing href/text manually.
    // Since the extraction expression uses document.querySelectorAll('a[href]'),
    // location.hostname, URL, element.innerText, element.parentElement,
    // element.querySelector, element.closest — we mock all of these.

    interface MockElement {
      href: string;
      innerText: string;
      textContent: string;
      parentElement: MockElement | null;
      children: MockElement[];
      tagName: string;
      querySelector: (sel: string) => MockElement | null;
      closest: (sel: string) => MockElement | null;
    }

    // Parse links from HTML using regex (good enough for test fixtures)
    const linkRegex = /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const containerRegex = /<div[^>]*>([\s\S]*?)<\/div>/gi;

    // Extract containers with their content
    const containers: Array<{ html: string; text: string }> = [];
    let containerMatch;
    while ((containerMatch = containerRegex.exec(html)) !== null) {
      const innerHtml = containerMatch[1];
      const text = innerHtml
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      containers.push({ html: innerHtml, text });
    }

    // Extract links
    const links: MockElement[] = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const innerHtml = match[2];
      const innerText = innerHtml.replace(/<[^>]+>/g, '').trim();
      const hasHeading = /<h[1-4][^>]*>/.test(innerHtml);
      const headingText = hasHeading
        ? innerHtml
            .replace(/<\/?h[1-4][^>]*>/g, '')
            .replace(/<[^>]+>/g, '')
            .trim()
        : null;

      // Find which container this link belongs to
      const parentContainer = containers.find(c => c.html.includes(href));
      const parentText = parentContainer?.text ?? innerText;

      const parentEl: MockElement = {
        href: '',
        innerText: parentText,
        textContent: parentText,
        parentElement: null,
        children: [],
        tagName: 'DIV',
        querySelector: () => null,
        closest: () => null,
      };

      const headingEl: MockElement | null = headingText
        ? {
            href: '',
            innerText: headingText,
            textContent: headingText,
            parentElement: null,
            children: [],
            tagName: 'H3',
            querySelector: () => null,
            closest: () => null,
          }
        : null;

      const el: MockElement = {
        href,
        innerText,
        textContent: innerText,
        parentElement: parentEl,
        children: headingEl ? [headingEl] : [],
        tagName: 'A',
        querySelector: (sel: string) => {
          if (sel.startsWith('h') && headingEl) return headingEl;
          return null;
        },
        closest: () => null,
      };

      links.push(el);
    }

    // Build the mock globals
    const mockDocument = {
      querySelectorAll: (_sel: string) => links,
    };
    const mockLocation = {
      hostname,
      href: `https://${hostname}/search?q=test`,
    };

    // Evaluate the expression in a sandboxed context.
    // .trim() is critical: the expression starts with a newline, and
    // `return \n(...)` triggers JS automatic semicolon insertion → undefined.
    const expression = getExtractionExpression(maxResults).trim();
    const fn = new Function('document', 'location', 'URL', `return ${expression}`);
    const resultJson = fn(mockDocument, mockLocation, URL) as string;
    return JSON.parse(resultJson) as unknown[];
  };

  it('extracts external links with titles from Google-like HTML', () => {
    const html = `
      <div>
        <a href="https://www.google.com/settings">Settings</a>
      </div>
      <div>
        <a href="https://example.com/article-1">
          <h3>Example Article About Testing</h3>
        </a>
        <span>This is a snippet about testing tools and practices.</span>
      </div>
      <div>
        <a href="https://another-site.org/page">
          <h3>Another Great Resource</h3>
        </a>
        <span>Description of this resource with useful details.</span>
      </div>
    `;

    const results = evaluateExtraction(html, 'www.google.com') as Array<{
      title: string;
      url: string;
    }>;

    expect(results.length).toBe(2);
    expect(results[0].title).toBe('Example Article About Testing');
    expect(results[0].url).toBe('https://example.com/article-1');
    expect(results[1].title).toBe('Another Great Resource');
    expect(results[1].url).toBe('https://another-site.org/page');
  });

  it('skips same-domain links', () => {
    const html = `
      <div>
        <a href="https://www.google.com/preferences"><h3>Google Preferences Page</h3></a>
      </div>
      <div>
        <a href="https://external.com/page"><h3>External Site Content</h3></a>
      </div>
    `;

    const results = evaluateExtraction(html, 'www.google.com') as Array<{
      title: string;
      url: string;
    }>;

    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://external.com/page');
  });

  it('skips search engine infrastructure domains', () => {
    const html = `
      <div><a href="https://accounts.google.com/login"><h3>Google Login Account</h3></a></div>
      <div><a href="https://gstatic.com/image.png"><h3>Static Image Resource</h3></a></div>
      <div><a href="https://real-result.com/page"><h3>Real Search Result</h3></a></div>
    `;

    const results = evaluateExtraction(html, 'www.google.com') as Array<{
      title: string;
      url: string;
    }>;

    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://real-result.com/page');
  });

  it('skips links with short titles (< 5 chars)', () => {
    const html = `
      <div><a href="https://example.com/a">Hi</a></div>
      <div><a href="https://example.com/b"><h3>Proper Title For Result</h3></a></div>
    `;

    const results = evaluateExtraction(html, 'www.google.com') as Array<{
      title: string;
      url: string;
    }>;

    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Proper Title For Result');
  });

  it('deduplicates links with the same origin+pathname', () => {
    const html = `
      <div><a href="https://example.com/page?ref=1"><h3>Example Page First Link</h3></a></div>
      <div><a href="https://example.com/page?ref=2"><h3>Example Page Second Link</h3></a></div>
    `;

    const results = evaluateExtraction(html, 'www.google.com') as Array<{
      title: string;
      url: string;
    }>;

    expect(results.length).toBe(1);
  });

  it('respects maxResults limit', () => {
    const html = `
      <div><a href="https://a.com/1"><h3>Result Alpha One Here</h3></a></div>
      <div><a href="https://b.com/2"><h3>Result Bravo Two Here</h3></a></div>
      <div><a href="https://c.com/3"><h3>Result Charlie Three Here</h3></a></div>
    `;

    const results = evaluateExtraction(html, 'www.google.com', 2);
    expect(results.length).toBe(2);
  });

  it('works with Bing-like HTML (link text as title, no heading)', () => {
    const html = `
      <div>
        <a href="https://news-site.com/story">News Site Breaking Story Title</a>
        <p>Summary of the breaking story with all the details.</p>
      </div>
    `;

    const results = evaluateExtraction(html, 'www.bing.com') as Array<{
      title: string;
      url: string;
    }>;

    expect(results.length).toBe(1);
    expect(results[0].title).toBe('News Site Breaking Story Title');
    expect(results[0].url).toBe('https://news-site.com/story');
  });
});

// ---------------------------------------------------------------------------
// sanitizeQuery
// ---------------------------------------------------------------------------

describe('sanitizeQuery', () => {
  it('replaces smart quotes with regular quotes', () => {
    expect(sanitizeQuery('\u201chello\u201d \u2018world\u2019')).toBe('"hello" "world"');
  });

  it('limits quoted phrases to 2', () => {
    const result = sanitizeQuery('"one" "two" "three" "four"');
    // First two quoted phrases kept, remaining unquoted
    expect(result).toBe('"one" "two" three four');
  });

  it('truncates long queries at word boundary', () => {
    const longQuery = 'word '.repeat(60); // 300 chars
    const result = sanitizeQuery(longQuery);
    expect(result.length).toBeLessThanOrEqual(200);
    // Should end at a complete word, not mid-word
    expect(result.endsWith('word')).toBe(true);
  });

  it('preserves short queries unchanged', () => {
    expect(sanitizeQuery('simple query')).toBe('simple query');
  });

  it('handles query with only smart quotes', () => {
    expect(sanitizeQuery('\u201ctest\u201d')).toBe('"test"');
  });
});

// ---------------------------------------------------------------------------
// simplifyQuery
// ---------------------------------------------------------------------------

describe('simplifyQuery', () => {
  it('removes quotes from quoted phrases', () => {
    expect(simplifyQuery('"hello world" test')).toBe('hello world test');
  });

  it('strips special characters', () => {
    expect(simplifyQuery('foo.bar + baz=qux')).toBe('foo bar baz qux');
  });

  it('truncates long simplified queries at word boundary', () => {
    const longQuery = 'abcdefgh '.repeat(20); // 180 chars
    const result = simplifyQuery(longQuery);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith('abcdefgh')).toBe(true);
  });

  it('collapses multiple spaces', () => {
    expect(simplifyQuery('foo   bar    baz')).toBe('foo bar baz');
  });

  it('handles complex LLM-generated query', () => {
    const complex =
      'SmolLM2 ONNX transformers.js "onnx-community" "SmolLM2-135M-ONNX" browser env config';
    const result = simplifyQuery(complex);
    expect(result).not.toContain('"');
    expect(result).toContain('SmolLM2');
    expect(result).toContain('onnx-community');
  });
});

// ---------------------------------------------------------------------------
// runBrowserSearch — retry with simplified query
// ---------------------------------------------------------------------------

describe('runBrowserSearch retry with simplified query', () => {
  beforeEach(() => {
    mockTabsCreate.mockReset();
    mockTabsCreate.mockImplementation((opts: { url: string }) =>
      Promise.resolve({ id: 99, title: '', url: opts.url, windowId: 1, status: 'complete' }),
    );
    mockTabsGet.mockReset();
    mockTabsGet.mockImplementation((tabId: number) =>
      Promise.resolve({ id: tabId, title: 'Test', url: 'https://test.com', status: 'complete' }),
    );
    mockTabsRemove.mockReset();
    mockTabsRemove.mockImplementation(() => Promise.resolve());
    mockExecuteScript.mockReset();
    mockTabsUpdate.mockReset();
    mockTabsUpdate.mockImplementation((tabId: number) =>
      Promise.resolve({ id: tabId, title: 'Updated', windowId: 1 }),
    );
  });

  it('retries with simplified query when initial search returns empty', async () => {
    vi.useFakeTimers();
    const createdUrls: string[] = [];
    const updatedUrls: string[] = [];
    let evaluateCallCount = 0;
    mockTabsCreate.mockImplementation((opts: { url: string }) => {
      createdUrls.push(opts.url);
      return Promise.resolve({ id: 20, title: '', url: opts.url, windowId: 1, status: 'complete' });
    });
    mockTabsUpdate.mockImplementation((tabId: number, props: { url?: string }) => {
      if (props.url) updatedUrls.push(props.url);
      return Promise.resolve({ id: tabId, title: 'Updated', windowId: 1 });
    });

    mockExecuteScript.mockImplementation(() => {
      evaluateCallCount++;
      // First 3 attempts (initial) return empty, next 3 (retry) return results
      if (evaluateCallCount <= 3) return Promise.resolve([{ result: '[]' }]);
      return Promise.resolve([{ result: JSON.stringify([
        { title: 'Result', url: 'https://example.com', snippet: 'Found it' },
      ]) }]);
    });

    const promise = runBrowserSearch('"complex" "query" "with" "many" "quotes"', 5, 'google');
    await vi.advanceTimersByTimeAsync(10000);
    const results = await promise;

    // Should have results from retry
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Result');

    // Initial URL via chrome.tabs.create, retry URL via chrome.tabs.update
    expect(createdUrls).toHaveLength(1);
    expect(updatedUrls).toHaveLength(1);

    // Retry URL should not contain quoted terms
    const retryUrl = decodeURIComponent(updatedUrls[0]);
    expect(retryUrl).not.toContain('"');

    vi.useRealTimers();
  });

  it('sanitizes query before first search', async () => {
    const createdUrls: string[] = [];
    mockTabsCreate.mockImplementation((opts: { url: string }) => {
      createdUrls.push(opts.url);
      return Promise.resolve({ id: 21, title: '', url: opts.url, windowId: 1, status: 'complete' });
    });

    mockExecuteScript.mockImplementation(() =>
      Promise.resolve([{ result: JSON.stringify([
        { title: 'Result', url: 'https://example.com', snippet: 'Snippet' },
      ]) }]),
    );

    // Use smart quotes — they should be replaced with regular quotes
    await runBrowserSearch('\u201csmart quoted\u201d query', 5, 'google');

    const searchUrl = decodeURIComponent(createdUrls[0]);
    expect(searchUrl).not.toContain('\u201c');
    expect(searchUrl).not.toContain('\u201d');
    expect(searchUrl).toContain('"smart quoted"');
  });
});

// ---------------------------------------------------------------------------
// SEARCH_CACHE
// ---------------------------------------------------------------------------

describe('SEARCH_CACHE', () => {
  beforeEach(() => {
    SEARCH_CACHE.clear();
  });

  it('starts empty', () => {
    expect(SEARCH_CACHE.size).toBe(0);
  });
});
