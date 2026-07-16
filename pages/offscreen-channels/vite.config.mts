import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { withPageConfig } from '@extension/vite-config';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import type { Plugin } from 'vite';

const rootDir = resolve(import.meta.dirname);
const srcDir = resolve(rootDir, 'src');

/**
 * Copy ONNX runtime WASM + MJS files to the build output so they are served
 * from the extension origin. This avoids blob: dynamic imports that MV3 CSP blocks.
 * Also removes Vite-hashed duplicates of WASM files that are emitted via
 * new URL() processing — the canonical names are used at runtime via wasmPaths.
 */
const copyOnnxRuntime = (): Plugin => ({
  name: 'copy-onnx-runtime',
  closeBundle() {
    const require = createRequire(import.meta.url);
    // onnxruntime-web main resolves into its dist/ directory
    const ortDistDir = dirname(require.resolve('onnxruntime-web'));

    const outDir = resolve(rootDir, '..', '..', 'dist', 'offscreen-channels', 'assets');
    mkdirSync(outDir, { recursive: true });

    // Copy canonical-name files that ONNX runtime loads via wasmPaths
    const files = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
    for (const file of files) {
      copyFileSync(resolve(ortDistDir, file), resolve(outDir, file));
    }

    // Remove Vite-hashed WASM duplicates (e.g. ort-wasm-simd-threaded.jsep-HASH.wasm)
    // These are emitted by Vite's new URL() processing but never loaded at runtime.
    for (const entry of readdirSync(outDir)) {
      if (entry.endsWith('.wasm') && !files.includes(entry)) {
        unlinkSync(resolve(outDir, entry));
      }
    }
  },
});

/**
 * Copy the vendored sherpa-onnx WASM engine (Emscripten glue + JS API + wasm)
 * into the build output so they load same-origin from the offscreen document.
 * These power the local SenseVoice STT engine. The glue has had its baked
 * data-package IIFE stripped so the ~239 MB model is fetched on demand instead.
 */
const copySherpaEngine = (): Plugin => ({
  name: 'copy-sherpa-engine',
  closeBundle() {
    const vendorDir = resolve(rootDir, 'vendor', 'sherpa');
    const outDir = resolve(rootDir, '..', '..', 'dist', 'offscreen-channels', 'assets');
    mkdirSync(outDir, { recursive: true });

    const files = [
      'sherpa-onnx-asr.js',
      'sherpa-onnx-wasm-main-vad-asr.js',
      'sherpa-onnx-wasm-main-vad-asr.wasm',
    ];
    for (const file of files) {
      copyFileSync(resolve(vendorDir, file), resolve(outDir, file));
    }
  },
});

// Resolve the empty-module polyfill once — kokoro-js imports `fs/promises` and `path`
// which vite-plugin-node-polyfills maps to node-stdlib-browser's empty.js.  However,
// the `fs/promises` subpath import confuses Vite into trying to resolve `empty.js/promises`.
// Explicitly aliasing it to the empty module fixes the build.
const emptyModule = resolve(
  rootDir,
  '../../node_modules/.pnpm/node-stdlib-browser@1.3.1/node_modules/node-stdlib-browser/esm/mock/empty.js',
);

export default withPageConfig({
  resolve: {
    alias: {
      '@src': srcDir,
      'fs/promises': emptyModule,
      // Baileys shim aliases: replace Node.js modules with browser-compatible versions
      ws: resolve(srcDir, 'ws-shim.ts'),
      pino: resolve(srcDir, 'pino-shim.ts'),
      '@cacheable/node-cache': resolve(srcDir, 'node-cache-shim.ts'),
      // Empty module aliases for Node.js-only Baileys optional deps
      child_process: emptyModule,
      'qrcode-terminal': emptyModule,
      jimp: emptyModule,
      sharp: emptyModule,
    },
  },
  plugins: [
    nodePolyfills({
      include: ['crypto', 'buffer', 'stream', 'events', 'assert', 'util', 'zlib', 'process'],
    }) as unknown as Plugin,
    copyOnnxRuntime(),
    copySherpaEngine(),
  ],
  optimizeDeps: {
    include: ['@extension/baileys'],
  },
  build: {
    outDir: resolve(rootDir, '..', '..', 'dist', 'offscreen-channels'),
    commonjsOptions: {
      include: [/packages\/baileys/, /node_modules/],
    },
  },
});
