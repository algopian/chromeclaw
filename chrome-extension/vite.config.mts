import { resolve } from 'node:path';
import { defineConfig, type Plugin, type PluginOption } from 'vite';
import libAssetsPlugin from '@laynezh/vite-plugin-lib-assets';
import makeManifestPlugin from './utils/plugins/make-manifest-plugin.js';
import { watchPublicPlugin, watchRebuildPlugin } from '@extension/hmr';
import { watchOption } from '@extension/vite-config';
import env, { IS_DEV, IS_PROD } from '@extension/env';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const rootDir = resolve(import.meta.dirname);
const srcDir = resolve(rootDir, 'src');

/**
 * Rollup plugin that replaces Node-only transitive deps with empty modules.
 * These come from @mariozechner/pi-ai's Bedrock/Vertex/proxy providers which
 * we never call at runtime (we only use openai-completions, anthropic-messages,
 * and google-generative-ai APIs). Using `external` leaves bare specifiers in
 * the output that the browser's ES module loader can't resolve.
 */
const shimNodeModules = (): Plugin => {
  const shimmed = [/^@aws-sdk\//, /^@smithy\//, /^undici$/, /^proxy-agent$/, /^http2$/];

  return {
    name: 'shim-node-modules',
    enforce: 'pre',
    resolveId(source) {
      if (shimmed.some(re => re.test(source))) {
        return { id: `\0shim:${source}`, moduleSideEffects: false, syntheticNamedExports: true };
      }
      return null;
    },
    load(id) {
      if (id.startsWith('\0shim:')) {
        return 'export default {}';
      }
      return null;
    },
  };
};

/**
 * Rollup plugin that replaces unused pi-ai OAuth modules with empty exports.
 * These modules contain base64-encoded OAuth credentials decoded via atob(),
 * which Chrome Web Store flags as "obfuscated code".
 */
const shimPiAiOAuth = (): Plugin => ({
  name: 'shim-pi-ai-oauth',
  enforce: 'pre',
  load(id) {
    if (id.includes('@mariozechner/pi-ai') && id.includes('/utils/oauth/') && !id.endsWith('.d.ts')) {
      return 'export default {}';
    }
    return null;
  },
});

const outDir = resolve(rootDir, '..', 'dist');
export default defineConfig({
  define: {
    'process.env': env,
  },
  resolve: {
    alias: {
      '@root': rootDir,
      '@src': srcDir,
      '@assets': resolve(srcDir, 'assets'),
    },
  },
  plugins: [
    libAssetsPlugin({
      outputPath: outDir,
    }) as PluginOption,
    watchPublicPlugin(),
    makeManifestPlugin({ outDir }),
    IS_DEV && watchRebuildPlugin({ reload: true, id: 'chrome-extension-hmr' }),
    nodePolyfills(),
    shimNodeModules(),
    shimPiAiOAuth(),
  ],
  publicDir: resolve(rootDir, 'public'),
  build: {
    lib: {
      name: 'BackgroundScript',
      fileName: 'background',
      formats: ['es'],
      entry: resolve(srcDir, 'background', 'index.ts'),
    },
    outDir,
    emptyOutDir: false,
    sourcemap: IS_DEV,
    minify: IS_PROD,
    reportCompressedSize: IS_PROD,
    watch: watchOption,
    rollupOptions: {
      external: ['chrome'],
      output: {
        // Chrome extensions reject filenames starting with "_" (reserved).
        // Rollup's virtual module prefix \0 produces chunk names like "_shim_...".
        sanitizeFileName: (name: string) => {
          const cleaned = name.replace(/\0/g, '');
          if (cleaned.startsWith('shim') || cleaned.startsWith('_shim')) {
            return cleaned.replace(/^_+/, '').replace(/:/g, '-');
          }
          return cleaned;
        },
      },
    },
  },
});
