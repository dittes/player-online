import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Security headers. The page needs no third-party origins: media you open is read locally, and network
 * streams (HLS, DASH, direct links) are the only thing allowed to reach other hosts, because that is what
 * "open a web address" means. `wasm-unsafe-eval` is for the FFmpeg WebAssembly decoder.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: https: http:",
  "connect-src 'self' blob: https: http:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/**
 * Production only: put the policy in the page itself (works on hosts that can't set headers, such as GitHub Pages)
 * and write a `_headers` file for Netlify and Cloudflare Pages with the same rules plus caching.
 */
function deploy(): Plugin {
  return {
    name: 'deploy-files',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
    generateBundle() {
      const lines = [
        '/*',
        ...Object.entries(HEADERS).map(([k, v]) => `  ${k}: ${v}`),
        '/sw.js',
        '  Cache-Control: no-cache',
        '/*.html',
        '  Cache-Control: no-cache',
        '/*/',
        '  Cache-Control: no-cache',
        '/manifest.webmanifest',
        '  Content-Type: application/manifest+json',
        '  Cache-Control: no-cache',
        '/assets/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '/vendor/*',
        '  Cache-Control: public, max-age=86400',
        '/icons/*',
        '  Cache-Control: public, max-age=604800',
        '',
      ];
      this.emitFile({ type: 'asset', fileName: '_headers', source: lines.join('\n') });
    },
  };
}

/** Gives the service worker a version and the list of this build's hashed files, so the whole app works offline after one visit. */
function serviceWorkerManifest(): Plugin {
  let outDir = 'dist';
  return {
    name: 'sw-manifest',
    apply: 'build',
    configResolved: (c) => void (outDir = c.build.outDir),
    closeBundle() {
      const assets = readdirSync(join(outDir, 'assets')).filter((f) => /\.(js|css)$/.test(f) && !/^(hls|dash)/.test(f));
      const path = join(outDir, 'sw.js');
      const src = readFileSync(path, 'utf8');
      const version = createHash('sha1').update(assets.join() + src).digest('hex').slice(0, 10);
      writeFileSync(path, src.replace('__VERSION__', version).replace('const BUILT = [];', `const BUILT = ${JSON.stringify(assets.map((f) => '/assets/' + f))};`));
    },
  };
}

/** Every generated page (see scripts/build-pages.mjs): the root redirect plus launcher, video, music and imprint per language. */
const PAGES = Object.fromEntries(
  ['index.html', ...['en', 'de', 'pl', 'cs'].flatMap((l) => ['', 'video/', 'music/', 'imprint/'].map((p) => `${l}/${p}index.html`))]
    .filter((f) => existsSync(f))
    .map((f) => [f.replace(/\/?index\.html$/, '') || 'index', f]),
);

export default defineConfig({
  plugins: [deploy(), serviceWorkerManifest()],
  build: { rollupOptions: { input: PAGES }, target: 'es2022', assetsInlineLimit: 0, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { port: 5174 },
  // Preview serves the real headers so the policy can be checked locally.
  preview: { port: 4174, headers: HEADERS },
});
