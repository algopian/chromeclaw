/**
 * ChatGPT MAIN world content script — extracted from content-fetch-main.ts.
 *
 * Injected via chrome.scripting.executeScript into the MAIN world of a
 * ChatGPT tab. Handles session token acquisition, sentinel antibot challenge
 * solving (Turnstile, Arkose, PoW), conversation management with
 * conversation_id + parent_message_id continuity, and SSE streaming.
 *
 * IMPORTANT: This function is serialized via chrome.scripting.executeScript({func}).
 * Chrome serializes ONLY the function body — module-scope imports and closures are
 * NOT captured. Everything must be self-contained within the function.
 */

import type { ContentFetchRequest } from './content-fetch-main';

export const chatgptMainWorldFetch = async (request: ContentFetchRequest): Promise<void> => {
  const { requestId, init, providerMetadata, retryAttempt } = request;
  const origin = window.location.origin;

  // ── Keep-alive: prevent inactivity detection ──
  // ChatGPT's client tracks mouse/keyboard events, Page Visibility API, and
  // telemetry heartbeats. A background tab with zero activity gets flagged as
  // stale, causing token refresh failures and 403s. Simulate periodic activity
  // and override visibility state for the duration of this request.
  const keepAliveInterval = setInterval(() => {
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: Math.random() * window.innerWidth,
        clientY: Math.random() * window.innerHeight,
      }),
    );
  }, 30_000);
  const origHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  const origVisibilityDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  try {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible',
      configurable: true,
    });
  } catch {
    /* non-configurable in some contexts */
  }

  const cleanupKeepAlive = () => {
    clearInterval(keepAliveInterval);
    try {
      if (origHiddenDesc) Object.defineProperty(document, 'hidden', origHiddenDesc);
      if (origVisibilityDesc)
        Object.defineProperty(document, 'visibilityState', origVisibilityDesc);
    } catch {
      /* ignore */
    }
  };

  try {
    // Parse the prompt and optional composite chatId from the lightweight stub body
    let cgPrompt = '';
    let existingConversationId = '';
    let existingParentMsgId = '';
    try {
      const bodyObj = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
        string,
        string
      >;
      cgPrompt = bodyObj.prompt ?? '';
      // chatId may be a composite "conversationId|parentMessageId"
      const chatId = bodyObj.chatId ?? '';
      if (chatId.includes('|')) {
        const parts = chatId.split('|');
        existingConversationId = parts[0] ?? '';
        existingParentMsgId = parts[1] ?? '';
      } else {
        existingConversationId = chatId;
      }
    } catch {
      /* use defaults */
    }

    // ── Step 1: Fetch access token and device ID from /api/auth/session ──
    let accessToken = '';
    let deviceId = providerMetadata?.deviceId ?? '';
    try {
      const sessionRes = await fetch('https://chatgpt.com/api/auth/session', {
        credentials: 'include',
      });
      if (sessionRes.ok) {
        const sessionData = (await sessionRes.json()) as Record<string, unknown>;
        accessToken = (sessionData.accessToken ?? '') as string;
        const serverDeviceId = ((sessionData as { oaiDeviceId?: string }).oaiDeviceId ??
          '') as string;
        if (serverDeviceId) deviceId = serverDeviceId;
      }
    } catch {
      /* ignore */
    }

    if (!deviceId) {
      deviceId = crypto.randomUUID();
    }

    // Persist deviceId back to the bridge for cross-request stability
    window.postMessage({ type: 'WEB_LLM_METADATA', requestId, metadata: { deviceId } }, origin);

    if (!accessToken) {
      window.postMessage(
        {
          type: 'WEB_LLM_ERROR',
          requestId,
          error:
            'No access token found for ChatGPT. Please visit https://chatgpt.com, log in, then reconnect via Settings \u2192 Models.',
        },
        origin,
      );
      return;
    }

    // ── Step 2: Base headers ──
    // Try to extract OAI-Client-Version and OAI-Client-Build-Number from the page.
    // These rotate with each OpenAI deploy. Dynamic extraction avoids stale hardcodes.
    const FALLBACK_CLIENT_VERSION = 'prod-80cda9c7df3122f53ffea02ee38084601d19d627';
    const FALLBACK_BUILD_NUMBER = '5623993';
    let oaiClientVersion = FALLBACK_CLIENT_VERSION;
    let oaiBuildNumber = FALLBACK_BUILD_NUMBER;
    try {
      const w = window as unknown as Record<string, unknown>;
      // Strategy 1: __NEXT_DATA__ (Next.js build manifest)
      const nextData = w.__NEXT_DATA__ as { buildId?: string } | undefined;
      if (nextData?.buildId && typeof nextData.buildId === 'string') {
        oaiClientVersion = nextData.buildId;
      }
      // Strategy 2: meta tag
      const metaBuild = document.querySelector('meta[name="build-id"]') as HTMLMetaElement | null;
      if (metaBuild?.content) {
        oaiClientVersion = metaBuild.content;
      }
      // Strategy 3: page globals set by ChatGPT bundle
      const oaiConfig = w.__oai_SSR_HTML as Record<string, unknown> | undefined;
      if (oaiConfig) {
        if (typeof oaiConfig.buildId === 'string') oaiClientVersion = oaiConfig.buildId;
        if (typeof oaiConfig.buildNumber === 'string') oaiBuildNumber = oaiConfig.buildNumber;
      }
      // Strategy 4: script tag content scan (last resort, only check first few)
      if (oaiClientVersion === FALLBACK_CLIENT_VERSION) {
        const scripts = document.querySelectorAll('script:not([src])');
        for (let i = 0; i < Math.min(scripts.length, 10); i++) {
          const text = scripts[i]?.textContent ?? '';
          const versionMatch = text.match(/["']OAI-Client-Version["']\s*:\s*["']([^"']+)["']/);
          if (versionMatch?.[1]) {
            oaiClientVersion = versionMatch[1];
            break;
          }
          const buildMatch = text.match(/buildNumber\s*[:=]\s*["'](\d+)["']/);
          if (buildMatch?.[1]) {
            oaiBuildNumber = buildMatch[1];
          }
        }
      }
    } catch {
      /* extraction is best-effort — use fallbacks */
    }

    const baseHeaders = (at: string | undefined, did: string): Record<string, string> => ({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'oai-device-id': did,
      'oai-language': 'en-US',
      'OAI-Client-Version': oaiClientVersion,
      'OAI-Client-Build-Number': oaiBuildNumber,
      Referer: window.location.href || 'https://chatgpt.com/',
      Origin: 'https://chatgpt.com',
      'sec-ch-ua': (
        navigator as Navigator & {
          userAgentData?: { brands?: { brand: string; version: string }[] };
        }
      ).userAgentData?.brands
        ? (
            navigator as Navigator & {
              userAgentData: { brands: { brand: string; version: string }[] };
            }
          ).userAgentData.brands
            .map(b => `"${b.brand}";v="${b.version}"`)
            .join(', ')
        : '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform
        ? `"${(navigator as Navigator & { userAgentData: { platform: string } }).userAgentData.platform}"`
        : '"Unknown"',
      ...(at ? { Authorization: `Bearer ${at}` } : {}),
    });

    const cgHeaders = baseHeaders(accessToken, deviceId);

    // ── Sentinel module discovery & auto-fingerprinting ──
    // The sentinel module's export names are minified and rotate on each OpenAI
    // deploy. Instead of hardcoding names, we discover functions by structural
    // signature (arity, shape) with a fast-path for currently known names.

    interface SentinelExports {
      chatRequirements: () => Promise<Record<string, unknown>>;
      turnstileSolver?: (key: unknown) => Promise<unknown>;
      arkoseEnforcer?: { getEnforcementToken: (reqs: unknown) => Promise<unknown> };
      powEnforcer?: unknown; // enforcer object OR PoW solver {answers, ...}
      headerBuilder: (...args: unknown[]) => Promise<Record<string, string>>;
    }

    const KNOWN_NAMES = {
      chatRequirements: 'bk',
      turnstileSolver: 'bi',
      arkoseEnforcer: 'bl',
      powEnforcer: 'bm',
      headerBuilder: 'fX',
    };

    /** Discover sentinel function roles from module exports by structural fingerprinting. */
    const discoverSentinelExports = (
      mod: Record<string, unknown>,
      diag: string[],
    ): SentinelExports | null => {
      // Fast path — check known minified names first
      if (
        typeof mod[KNOWN_NAMES.chatRequirements] === 'function' &&
        typeof mod[KNOWN_NAMES.headerBuilder] === 'function'
      ) {
        diag.push('discovery=known-names');
        return {
          chatRequirements: mod[
            KNOWN_NAMES.chatRequirements
          ] as SentinelExports['chatRequirements'],
          turnstileSolver:
            typeof mod[KNOWN_NAMES.turnstileSolver] === 'function'
              ? (mod[KNOWN_NAMES.turnstileSolver] as SentinelExports['turnstileSolver'])
              : undefined,
          arkoseEnforcer:
            mod[KNOWN_NAMES.arkoseEnforcer] &&
            typeof (mod[KNOWN_NAMES.arkoseEnforcer] as Record<string, unknown>)
              .getEnforcementToken === 'function'
              ? (mod[KNOWN_NAMES.arkoseEnforcer] as SentinelExports['arkoseEnforcer'])
              : undefined,
          powEnforcer: mod[KNOWN_NAMES.powEnforcer] ?? undefined,
          headerBuilder: mod[KNOWN_NAMES.headerBuilder] as SentinelExports['headerBuilder'],
        };
      }

      // Fallback — scan all exports by function body content + structural shape.
      // Minified function bodies still contain string literals (API paths, header
      // names) that survive name rotations. We match on those first, then fall back
      // to arity as a tie-breaker.
      diag.push('discovery=fingerprint');
      const exportKeys = Object.keys(mod);
      diag.push(`exports=[${exportKeys.join(',')}]`);

      let chatRequirements: SentinelExports['chatRequirements'] | undefined;
      let headerBuilder: SentinelExports['headerBuilder'] | undefined;
      let turnstileSolver: SentinelExports['turnstileSolver'] | undefined;
      let arkoseEnforcer: SentinelExports['arkoseEnforcer'] | undefined;
      let powEnforcer: unknown;

      // Phase 1: Body fingerprinting — scan fn.toString() for stable string patterns
      for (const key of exportKeys) {
        const val = mod[key];
        if (typeof val === 'function') {
          const fn = val as (...args: unknown[]) => unknown;
          let body = '';
          try {
            body = fn.toString();
          } catch {
            /* toString may fail on native code */
          }

          if (body && !body.startsWith('[')) {
            // chatRequirements: references the sentinel API endpoint but NOT the header name
            if (
              !chatRequirements &&
              body.includes('chat-requirements') &&
              !body.includes('requirements-token')
            ) {
              chatRequirements = fn as SentinelExports['chatRequirements'];
              diag.push(`chatRequirements=${key}(body-match)`);
            }
            // headerBuilder: references the sentinel header name
            else if (
              !headerBuilder &&
              (body.includes('requirements-token') || body.includes('openai-sentinel'))
            ) {
              headerBuilder = fn as SentinelExports['headerBuilder'];
              diag.push(`headerBuilder=${key}(body-match)`);
            }
            // turnstileSolver: references turnstile (case-insensitive), arity ≤ 2
            else if (!turnstileSolver && fn.length <= 2 && /turnstile/i.test(body)) {
              turnstileSolver = fn as SentinelExports['turnstileSolver'];
              diag.push(`turnstileSolver=${key}(body-match)`);
            }
          }
        } else if (val && typeof val === 'object') {
          const obj = val as Record<string, unknown>;
          if (typeof obj.getEnforcementToken === 'function') {
            if ((obj as Record<string, unknown>).answers === undefined && !arkoseEnforcer) {
              arkoseEnforcer = obj as SentinelExports['arkoseEnforcer'];
              diag.push(`arkoseEnforcer=${key}(hasGetEnforcementToken)`);
            } else if (!powEnforcer) {
              powEnforcer = obj;
              diag.push(`powEnforcer=${key}(enforcer)`);
            }
          } else if (obj.answers !== undefined && !powEnforcer) {
            powEnforcer = obj;
            diag.push(`powEnforcer=${key}(hasPowAnswers)`);
          }
        }
      }

      // Phase 1.5: Module-level source scan — if body fingerprinting missed chatRequirements
      // or headerBuilder, check whether the *combined* source of all exported functions
      // contains the target strings. This catches cases where minifiers hoist string
      // literals to module-scope variables (e.g. `const a = "chat-requirements";`),
      // making individual fn.toString() miss the match.
      if (!chatRequirements || !headerBuilder) {
        let combinedSource = '';
        for (const key of exportKeys) {
          const val = mod[key];
          if (typeof val === 'function') {
            try {
              combinedSource += (val as (...a: unknown[]) => unknown).toString() + '\n';
            } catch {
              /* ignore */
            }
          }
        }
        if (combinedSource) {
          const moduleHasChatReqs = combinedSource.includes('chat-requirements');
          const moduleHasHeader =
            combinedSource.includes('requirements-token') ||
            combinedSource.includes('openai-sentinel');
          if (moduleHasChatReqs || moduleHasHeader) {
            diag.push(
              `module-source-scan=hit(chatReqs=${moduleHasChatReqs},header=${moduleHasHeader})`,
            );
          }
        }
      }

      // Phase 2: Arity fallback — if body fingerprinting missed chatRequirements or headerBuilder
      if (!headerBuilder) {
        for (const key of exportKeys) {
          const val = mod[key];
          if (typeof val === 'function' && (val as (...a: unknown[]) => unknown).length === 5) {
            headerBuilder = val as SentinelExports['headerBuilder'];
            diag.push(`headerBuilder=${key}(arity5)`);
            break;
          }
        }
      }
      if (!chatRequirements) {
        const arity0Fns: Array<{ name: string; fn: (...args: unknown[]) => unknown }> = [];
        for (const key of exportKeys) {
          const val = mod[key];
          if (
            typeof val === 'function' &&
            (val as (...a: unknown[]) => unknown).length === 0 &&
            val !== headerBuilder &&
            val !== turnstileSolver
          ) {
            arity0Fns.push({ name: key, fn: val as (...a: unknown[]) => unknown });
          }
        }
        if (arity0Fns.length === 1) {
          chatRequirements = arity0Fns[0]!.fn as SentinelExports['chatRequirements'];
          diag.push(`chatRequirements=${arity0Fns[0]!.name}(arity0-unique)`);
        } else if (arity0Fns.length > 1) {
          // Filter out well-known non-sentinel exports and prefer async functions
          // (chatRequirements is always async — it fetches from /sentinel/chat-requirements)
          const EXCLUDED_NAMES = new Set(['__esModule', 'default']);
          const filtered = arity0Fns.filter(f => !EXCLUDED_NAMES.has(f.name));
          // Prefer async functions (their toString contains 'async')
          const asyncCandidates = filtered.filter(f => {
            try {
              return f.fn.toString().includes('async');
            } catch {
              return false;
            }
          });
          const best = asyncCandidates.length > 0 ? asyncCandidates : filtered;
          if (best.length === 1) {
            chatRequirements = best[0]!.fn as SentinelExports['chatRequirements'];
            diag.push(`chatRequirements=${best[0]!.name}(arity0-filtered)`);
          } else if (best.length > 1) {
            // Still ambiguous — pick the first candidate but log the ambiguity
            chatRequirements = best[0]!.fn as SentinelExports['chatRequirements'];
            diag.push(
              `chatRequirements=${best[0]!.name}(arity0-ambiguous,${best.length}-candidates)`,
            );
          }
        }
      }
      if (!turnstileSolver) {
        for (const key of exportKeys) {
          const val = mod[key];
          if (
            typeof val === 'function' &&
            (val as (...a: unknown[]) => unknown).length === 1 &&
            val !== chatRequirements &&
            val !== headerBuilder
          ) {
            turnstileSolver = val as SentinelExports['turnstileSolver'];
            diag.push(`turnstileSolver=${key}(arity1)`);
            break;
          }
        }
      }

      if (!chatRequirements || !headerBuilder) {
        diag.push(
          `missing: chatRequirements=${!!chatRequirements}, headerBuilder=${!!headerBuilder}`,
        );
        return null;
      }

      return { chatRequirements, turnstileSolver, arkoseEnforcer, powEnforcer, headerBuilder };
    };

    // ── Multi-strategy sentinel module URL discovery ──
    // Try multiple strategies to find the oaistatic.com sentinel script URL.

    const findSentinelAssetUrl = async (diag: string[]): Promise<string | null> => {
      // Collect all oaistatic.com JS URLs from multiple sources, then validate
      // each by importing and running discoverSentinelExports(). ChatGPT loads
      // many scripts from oaistatic.com — only the sentinel module will have
      // exports matching our fingerprints.

      const collectCandidateUrls = (): string[] => {
        const urls: string[] = [];
        const seen = new Set<string>();
        const add = (url: string) => {
          if (url && !seen.has(url)) {
            seen.add(url);
            urls.push(url);
          }
        };

        // DOM <script> tags
        for (const s of Array.from(document.scripts)) {
          if (s.src?.includes('oaistatic.com') && s.src.endsWith('.js')) add(s.src);
        }

        // <link rel="modulepreload">
        for (const l of Array.from(document.querySelectorAll('link[rel="modulepreload"]'))) {
          const href = (l as HTMLLinkElement).href;
          if (href?.includes('oaistatic.com') && href.endsWith('.js')) add(href);
        }

        // Performance API (catches dynamically import()-loaded scripts)
        try {
          const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
          for (const e of entries
            .filter(e => e.name.includes('oaistatic.com') && e.name.endsWith('.js'))
            .sort((a, b) => b.startTime - a.startTime)) {
            add(e.name);
          }
        } catch {
          /* Performance API may be restricted */
        }

        return urls;
      };

      // Try-import a candidate URL and check for sentinel exports.
      // Pre-filter: sentinel modules typically have <50 exports. Large app bundles
      // (200+ exports) are skipped to avoid slow parse + potential side effects.
      const MAX_SENTINEL_EXPORTS = 50;

      const tryCandidate = async (url: string): Promise<boolean> => {
        try {
          const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
          if (Object.keys(mod).length > MAX_SENTINEL_EXPORTS) return false;
          const testDiag: string[] = [];
          const exports = discoverSentinelExports(mod, testDiag);
          return exports !== null;
        } catch {
          return false;
        }
      };

      // Quick scan — check candidates without waiting
      let candidates = collectCandidateUrls();
      if (candidates.length > 0) {
        diag.push(`asset=candidates(${candidates.length})`);
        for (const url of candidates) {
          if (await tryCandidate(url)) {
            diag.push(`asset=verified(${url.split('/').pop()})`);
            return url;
          }
        }
        diag.push('asset=candidates-no-sentinel');
      }

      // Poll DOM/performance for up to 5s (the SPA may still be hydrating)
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        const newCandidates = collectCandidateUrls();
        // Only check newly discovered URLs
        const fresh = newCandidates.filter(u => !candidates.includes(u));
        if (fresh.length > 0) {
          candidates = newCandidates;
          for (const url of fresh) {
            if (await tryCandidate(url)) {
              diag.push(`asset=poll-verified(${url.split('/').pop()})`);
              return url;
            }
          }
        }
      }

      // Strategy 4: Fetch HTML page and extract oaistatic URLs from the response.
      // Background tabs may never fully hydrate the Next.js SPA, so DOM-based
      // discovery fails. The HTML response may contain asset URLs directly or
      // reference a build manifest. ChatGPT may also serve the HTML with
      // relative paths or different CDN subdomains — match broadly.
      try {
        diag.push('asset=trying-html-fetch');
        const htmlRes = await fetch('https://chatgpt.com/', { credentials: 'include' });
        if (htmlRes.ok) {
          const html = await htmlRes.text();
          // Match any oaistatic.com JS URL (full or protocol-relative)
          const urlMatches = html.match(
            /(?:https?:)?\/\/[a-z0-9.-]*oaistatic\.com\/[^"'\s<>]+\.js/g,
          );
          if (urlMatches && urlMatches.length > 0) {
            const uniqueUrls = [
              ...new Set(urlMatches.map(u => (u.startsWith('//') ? `https:${u}` : u))),
            ];
            diag.push(`asset=html-candidates(${uniqueUrls.length})`);
            // Try each candidate — import and check for sentinel exports
            for (const candidateUrl of uniqueUrls) {
              try {
                const candidateModule = (await import(/* @vite-ignore */ candidateUrl)) as Record<
                  string,
                  unknown
                >;
                const testDiag: string[] = [];
                const exports = discoverSentinelExports(candidateModule, testDiag);
                if (exports) {
                  diag.push(`asset=html-verified(${candidateUrl.split('/').pop()})`);
                  return candidateUrl;
                }
              } catch {
                // Not the sentinel module or import failed — continue
              }
            }
            diag.push('asset=html-no-sentinel');
          } else {
            // Also try extracting from inline script that references asset paths
            const assetPathMatch = html.match(/["']\/assets\/[a-zA-Z0-9_-]+\.js["']/g);
            if (assetPathMatch && assetPathMatch.length > 0) {
              const paths = [...new Set(assetPathMatch.map(m => m.replace(/["']/g, '')))];
              diag.push(`asset=html-relative-paths(${paths.length})`);
              for (const path of paths) {
                const fullUrl = `https://cdn.oaistatic.com${path}`;
                try {
                  const candidateModule = (await import(/* @vite-ignore */ fullUrl)) as Record<
                    string,
                    unknown
                  >;
                  const testDiag: string[] = [];
                  const exports = discoverSentinelExports(candidateModule, testDiag);
                  if (exports) {
                    diag.push(`asset=html-relative-verified(${path})`);
                    return fullUrl;
                  }
                } catch {
                  // Not the sentinel module — continue
                }
              }
              diag.push('asset=html-relative-no-sentinel');
            } else {
              diag.push('asset=html-no-urls');
            }
          }
        } else {
          diag.push(`asset=html-fetch-${htmlRes.status}`);
        }
      } catch (e) {
        diag.push(`asset=html-err(${e instanceof Error ? e.message : 'unknown'})`);
      }

      // Strategy 5: Last-resort known fallback URL.
      // This URL may go stale when OpenAI deploys, but it's better than failing
      // completely. The discoverSentinelExports() validation will catch if the
      // module's export names have rotated.
      const FALLBACK_SENTINEL_URL = 'https://cdn.oaistatic.com/assets/i5bamk05qmvsi6c3.js';
      try {
        const fallbackModule = (await import(/* @vite-ignore */ FALLBACK_SENTINEL_URL)) as Record<
          string,
          unknown
        >;
        const testDiag: string[] = [];
        const exports = discoverSentinelExports(fallbackModule, testDiag);
        if (exports) {
          diag.push(`asset=fallback-verified(${FALLBACK_SENTINEL_URL.split('/').pop()})`);
          return FALLBACK_SENTINEL_URL;
        }
        diag.push('asset=fallback-no-sentinel-exports');
      } catch {
        diag.push('asset=fallback-import-failed');
      }

      diag.push('asset=not-found');
      return null;
    };

    // ── Resolve sentinel headers (warmup + challenge solving) ──
    // Extracted as inner function to enable retry on 403.

    const resolveSentinelHeaders = async (
      headers: Record<string, string>,
      diag: string[],
    ): Promise<{ sentinelHeaders: Record<string, string>; sentinelError: string }> => {
      let sentinelHeaders: Record<string, string> = {};
      let sentinelError = '';

      // Warmup Sentinel endpoints (must complete BEFORE challenge solving).
      // These prime server-side sentinel state; skipping them causes 403 "unusual activity".
      const warmupUrls = [
        'https://chatgpt.com/backend-api/conversation/init',
        'https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare',
        'https://chatgpt.com/backend-api/sentinel/chat-requirements/finalize',
      ];
      for (const warmupUrl of warmupUrls) {
        try {
          const r = await fetch(warmupUrl, {
            method: 'POST',
            headers,
            body: '{}',
            credentials: 'include',
          });
          diag.push(`warmup:${warmupUrl.split('/').pop()}=${r.status}`);
        } catch (e) {
          diag.push(
            `warmup:${warmupUrl.split('/').pop()}=err(${e instanceof Error ? e.message : 'unknown'})`,
          );
        }
      }

      // Sentinel antibot challenge solving
      try {
        const assetUrl = await findSentinelAssetUrl(diag);
        if (!assetUrl) {
          sentinelError =
            'Sentinel oaistatic script not found on page. The ChatGPT page may not have fully loaded.';
          return { sentinelHeaders, sentinelError };
        }

        const sentinelModule = (await import(/* @vite-ignore */ assetUrl)) as Record<
          string,
          unknown
        >;

        // Discover function roles by structural fingerprinting
        const exports = discoverSentinelExports(sentinelModule, diag);
        if (!exports) {
          const exportNames = Object.keys(sentinelModule).join(', ');
          sentinelError = `Sentinel function discovery failed — could not identify chatRequirements/headerBuilder from exports: [${exportNames}]. Function names may have been rotated.`;
          return { sentinelHeaders, sentinelError };
        }

        // Call chatRequirements to get challenge parameters
        const chatReqs = await Promise.race([
          exports.chatRequirements(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('chat-requirements timed out after 15s')), 15_000),
          ),
        ]);

        // Validate the response looks like real chat-requirements
        const turnstile = chatReqs?.turnstile as Record<string, unknown> | undefined;
        const turnstileKey = turnstile?.bx ?? turnstile?.dx;

        if (!turnstileKey) {
          sentinelError = 'Sentinel chat-requirements response missing turnstile key (bx/dx)';
          return { sentinelHeaders, sentinelError };
        }

        // Solve Turnstile challenge
        let turnstileToken: unknown = null;
        try {
          if (exports.turnstileSolver) {
            turnstileToken = await Promise.race([
              exports.turnstileSolver(turnstileKey),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Turnstile solver timed out after 15s')), 15_000),
              ),
            ]);
          }
        } catch (e) {
          diag.push(`turnstile-err=${e instanceof Error ? e.message : 'unknown'}`);
        }

        // Solve Arkose challenge
        let arkoseToken: unknown = null;
        try {
          if (exports.arkoseEnforcer?.getEnforcementToken) {
            arkoseToken = await Promise.race([
              exports.arkoseEnforcer.getEnforcementToken(chatReqs),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Arkose timed out after 15s')), 15_000),
              ),
            ]);
          }
        } catch (e) {
          diag.push(`arkose-err=${e instanceof Error ? e.message : 'unknown'}`);
        }

        // Resolve proof-of-work token. powEnforcer may be:
        // - An enforcer object with getEnforcementToken() (older API)
        // - A PoW solver object with {answers, maxAttempts, requirementsSeed, sid}
        //   which headerBuilder uses directly to build the Proof-Token header
        let proofToken: unknown = null;
        try {
          if (exports.powEnforcer && typeof exports.powEnforcer === 'object') {
            const pow = exports.powEnforcer as Record<string, unknown>;
            if (typeof pow.getEnforcementToken === 'function') {
              proofToken = await Promise.race([
                (pow.getEnforcementToken as (r: unknown) => Promise<unknown>)(chatReqs),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('Proof token timed out after 15s')), 15_000),
                ),
              ]);
            } else if (pow.answers !== undefined) {
              proofToken = exports.powEnforcer;
            }
          }
        } catch (e) {
          diag.push(`pow-err=${e instanceof Error ? e.message : 'unknown'}`);
        }

        // Build sentinel headers
        const extraHeaders = await Promise.race([
          exports.headerBuilder(chatReqs, arkoseToken, turnstileToken, proofToken, null),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('headerBuilder timed out after 15s')), 15_000),
          ),
        ]);
        if (typeof extraHeaders === 'object' && extraHeaders !== null) {
          sentinelHeaders = extraHeaders as Record<string, string>;
        }
      } catch (e) {
        sentinelError = `Sentinel challenge failed: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Check for Signal Orchestrator (behavioral biometrics) — informational only
      try {
        const soKeys = Object.keys(window).filter(k => k.startsWith('__oai_so_'));
        diag.push(`signal-orchestrator=${soKeys.length > 0 ? `${soKeys.length}-props` : 'absent'}`);
      } catch {
        /* ignore */
      }

      return { sentinelHeaders, sentinelError };
    };

    // ── Step 3: Resolve sentinel headers ──
    const diag: string[] = [];
    let { sentinelHeaders, sentinelError } = await resolveSentinelHeaders(cgHeaders, diag);

    // ── Step 4: Build conversation request body ──
    const messageId = crypto.randomUUID();
    const parentMessageId = existingParentMsgId || crypto.randomUUID();

    const conversationBody: Record<string, unknown> = {
      action: 'next',
      messages: [
        {
          id: messageId,
          author: { role: 'user' },
          create_time: Date.now() / 1000,
          content: {
            content_type: 'text',
            parts: [cgPrompt],
          },
          metadata: {
            serialization_metadata: { custom_symbol_offsets: [] },
          },
        },
      ],
      parent_message_id: parentMessageId,
      model: 'auto',
      timezone_offset_min: new Date().getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      conversation_mode: { kind: 'primary_assistant' },
      enable_message_followups: true,
      system_hints: [],
      supports_buffering: true,
      client_contextual_info: {
        is_dark_mode: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false,
        time_since_loaded: Math.floor(performance.now() / 1000),
        page_height: window.innerHeight,
        page_width: window.innerWidth,
        pixel_ratio: window.devicePixelRatio || 1,
        screen_height: screen.height,
        screen_width: screen.width,
        app_name: 'chatgpt.com',
      },
      paragen_cot_summary_display_override: 'allow',
      force_parallel_switch: 'auto',
    };

    // Include conversation_id for continuation turns
    if (existingConversationId) {
      conversationBody.conversation_id = existingConversationId;
    }

    // ── Step 5: Send conversation request (with sentinel headers if available) ──
    // On 403, retry once with freshly resolved sentinel tokens + refreshed access token.

    const sendConversation = async (headers: Record<string, string>): Promise<Response> => {
      const finalHeaders =
        Object.keys(sentinelHeaders).length > 0 ? { ...headers, ...sentinelHeaders } : headers;
      return fetch('https://chatgpt.com/backend-api/conversation', {
        method: 'POST',
        headers: finalHeaders,
        credentials: 'include',
        body: JSON.stringify(conversationBody),
      });
    };

    let cgResponse: Response;
    try {
      cgResponse = await sendConversation(cgHeaders);
    } catch {
      // Network error — retry without sentinel headers
      cgResponse = await fetch('https://chatgpt.com/backend-api/conversation', {
        method: 'POST',
        headers: cgHeaders,
        credentials: 'include',
        body: JSON.stringify(conversationBody),
      });
    }

    // ── 403 Retry: refresh access token + re-solve sentinel challenges ──
    if (cgResponse.status === 403) {
      diag.push('retry=403');

      // Refresh access token
      try {
        const retrySession = await fetch('https://chatgpt.com/api/auth/session', {
          credentials: 'include',
        });
        if (retrySession.ok) {
          const retryData = (await retrySession.json()) as Record<string, unknown>;
          const newToken = (retryData.accessToken ?? '') as string;
          if (newToken) {
            accessToken = newToken;
            diag.push('retry-token=refreshed');
          }
        }
      } catch {
        /* use existing token */
      }

      const retryHeaders = baseHeaders(accessToken, deviceId);
      const retryDiag: string[] = [];
      const retryResult = await resolveSentinelHeaders(retryHeaders, retryDiag);
      diag.push(...retryDiag.map(d => `retry:${d}`));

      sentinelHeaders = retryResult.sentinelHeaders;
      sentinelError = retryResult.sentinelError;

      try {
        cgResponse = await sendConversation(retryHeaders);
      } catch {
        cgResponse = await fetch('https://chatgpt.com/backend-api/conversation', {
          method: 'POST',
          headers: retryHeaders,
          credentials: 'include',
          body: JSON.stringify(conversationBody),
        });
      }
    }

    // ── 403 still? Request tab refresh from bridge and bail ──
    // The bridge will refresh the provider tab (resetting server-side sentinel state)
    // and re-inject the MAIN world script from scratch. Only attempt once.
    if (!cgResponse.ok && cgResponse.status === 403 && (retryAttempt ?? 0) < 1) {
      diag.push('retry=tab-refresh-requested');
      const diagStr = diag.length > 0 ? ` [diag: ${diag.join('; ')}]` : '';
      window.postMessage({ type: 'WEB_LLM_RETRY_REFRESH', requestId, diag: diagStr }, origin);
      return;
    }

    if (!cgResponse.ok) {
      let errorBody = '';
      try {
        errorBody = await cgResponse.text();
        if (errorBody.length > 500) errorBody = errorBody.slice(0, 500);
      } catch {
        /* ignore */
      }
      const diagStr = diag.length > 0 ? ` [diag: ${diag.join('; ')}]` : '';
      const sentinelHint = sentinelError
        ? ` Sentinel: ${sentinelError}${diagStr}`
        : Object.keys(sentinelHeaders).length === 0
          ? ` Sentinel headers were not available — the oaistatic script may not have loaded on this page.${diagStr}`
          : diagStr;
      const authHint =
        cgResponse.status === 401 || cgResponse.status === 403
          ? ` Please visit https://chatgpt.com to verify your account is active, then log out and log back in via Settings → Models.${sentinelHint}`
          : sentinelHint;
      window.postMessage(
        {
          type: 'WEB_LLM_ERROR',
          requestId,
          error: `HTTP ${cgResponse.status}: ${cgResponse.statusText}${errorBody ? ` — ${errorBody}` : ''}${authHint}`,
        },
        origin,
      );
      return;
    }

    const cgReader = cgResponse.body?.getReader();
    if (!cgReader) {
      window.postMessage(
        { type: 'WEB_LLM_ERROR', requestId, error: 'No response body from ChatGPT' },
        origin,
      );
      return;
    }

    // ── Stream SSE response ──

    // Track conversation_id and last assistant message ID for continuation
    let capturedConversationId = existingConversationId;
    let capturedParentMsgId = '';

    const cgDecoder = new TextDecoder();
    let cgBuffer = '';

    while (true) {
      const { done, value } = await cgReader.read();
      if (done) break;

      cgBuffer += cgDecoder.decode(value, { stream: true });

      // Process complete lines
      while (cgBuffer.includes('\n')) {
        const lineEnd = cgBuffer.indexOf('\n');
        const line = cgBuffer.slice(0, lineEnd).trim();
        cgBuffer = cgBuffer.slice(lineEnd + 1);

        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();

          // Extract conversation_id and message ID for continuity
          if (dataStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(dataStr) as Record<string, unknown>;

              // Extract model information from server_ste_metadata events
              if (parsed.type === 'server_ste_metadata') {
                const metadata = parsed.metadata as Record<string, unknown> | undefined;
                const modelSlug = metadata?.model_slug as string | undefined;
                if (modelSlug) {
                  // Emit model metadata for the bridge to capture
                  window.postMessage(
                    { type: 'WEB_LLM_METADATA', requestId, metadata: { modelId: modelSlug } },
                    origin,
                  );
                }
              }

              if (parsed.conversation_id && typeof parsed.conversation_id === 'string') {
                capturedConversationId = parsed.conversation_id;
              }
              const msg = parsed.message as Record<string, unknown> | undefined;
              if (msg?.id && typeof msg.id === 'string') {
                const author = msg.author as Record<string, string> | undefined;
                if (author?.role === 'assistant') {
                  capturedParentMsgId = msg.id;
                }
              }
            } catch {
              /* ignore parse errors */
            }
          }

          const sseChunk = `${line}\n\n`;
          window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: sseChunk }, origin);
        }
      }
    }

    // Flush remaining data from decoder
    const cgFinal = cgDecoder.decode();
    if (cgFinal) cgBuffer += cgFinal;
    // Process any remaining complete lines
    while (cgBuffer.includes('\n')) {
      const lineEnd = cgBuffer.indexOf('\n');
      const line = cgBuffer.slice(0, lineEnd).trim();
      cgBuffer = cgBuffer.slice(lineEnd + 1);
      if (line.startsWith('data: ')) {
        window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: `${line}\n\n` }, origin);
      }
    }
    // Handle final line with no trailing newline
    const cgRemaining = cgBuffer.trim();
    if (cgRemaining.startsWith('data: ')) {
      window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: `${cgRemaining}\n\n` }, origin);
    }

    // Inject synthetic conversation state event so the bridge can cache
    // conversation_id + parent_message_id for the next turn.
    if (capturedConversationId) {
      const compositeId = capturedParentMsgId
        ? `${capturedConversationId}|${capturedParentMsgId}`
        : capturedConversationId;
      const idChunk = `data: ${JSON.stringify({ type: 'chatgpt:conversation_state', conversation_id: compositeId })}\n\n`;
      window.postMessage({ type: 'WEB_LLM_CHUNK', requestId, chunk: idChunk }, origin);
    }

    window.postMessage({ type: 'WEB_LLM_DONE', requestId }, origin);
  } finally {
    cleanupKeepAlive();
  }
};
