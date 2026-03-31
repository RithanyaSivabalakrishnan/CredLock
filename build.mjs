/**
 * build.mjs
 * CredLock — esbuild-based extension bundler.
 *
 * Outputs (all under dist/):
 *   background.js        — MV3 service worker
 *   content.js           — content script (merchant pages)
 *   vault.js             — vault UI + model + crypto (popup & side-panel)
 *   manifest.json        — dist-relative paths (differs from source manifest)
 *   ui/vault_container.html  — popup / side-panel shell
 *   ui/vault_container.css   — vault UI styles
 *   assets/icons/*.png       — extension icons (16, 48, 128)
 *   assets/images/*.png      — promotional images (banner)
 *   wasm/crypto_engine.wasm  — compiled from src/wasm/ (if present)
 *
 * Usage:
 *   node build.mjs           — one-shot production build
 *   node build.mjs --watch   — incremental watch mode
 */

import * as esbuild from 'esbuild';
import {
  copyFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch     = process.argv.includes('--watch');

// ── esbuild entry points ──────────────────────────────────────────────────

const sharedConfig = {
  bundle:    true,
  format:    'esm',
  target:    ['chrome116'],
  sourcemap: watch ? 'inline' : false,
  logLevel:  'info',
  // Exclude chrome.* globals from bundling — they are runtime-provided
  external:  [],
};

const entryPoints = [
  { in: 'src/background/extension_main.js', out: 'dist/background' },
  { in: 'src/content/merchant_site.js',     out: 'dist/content'    },
  { in: 'src/vault/ui/vault_container.js',  out: 'dist/vault'      },
];

// ── Directory scaffold ────────────────────────────────────────────────────

function ensureDirs() {
  for (const dir of [
    'dist',
    'dist/ui',
    'dist/assets/icons',
    'dist/assets/images',
    'dist/wasm',
  ]) {
    mkdirSync(join(__dirname, dir), { recursive: true });
  }
}

// ── Manifest rewrite ──────────────────────────────────────────────────────

/**
 * Reads the source manifest.json, rewrites all paths to be relative to
 * dist/ (the extension root when loaded unpacked), and writes dist/manifest.json.
 *
 * Key differences from the source manifest:
 *   "service_worker": "dist/background.js"  →  "background.js"
 *   "js": ["dist/content.js"]               →  ["content.js"]
 *   "default_popup": "src/vault/ui/..."     →  "ui/vault_container.html"
 *   "side_panel.default_path": "src/..."    →  "ui/vault_container.html"
 */
function writeDistManifest() {
  const src = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf8'));

  src.background.service_worker = 'background.js';

  src.content_scripts = src.content_scripts.map(cs => ({
    ...cs,
    js: cs.js.map(p => p.replace(/^dist\//, '')),
  }));

  src.action.default_popup      = 'ui/vault_container.html';
  src.side_panel.default_path   = 'ui/vault_container.html';

  src.web_accessible_resources = src.web_accessible_resources.map(entry => ({
    ...entry,
    resources: entry.resources.map(r =>
      r
        .replace('src/vault/ui/vault_container.html', 'ui/vault_container.html')
        .replace('src/vault/ui/vault_container.css',  'ui/vault_container.css')
        .replace('dist/vault.js',                     'vault.js')
        .replace('src/wasm/crypto_engine.wasm',       'wasm/crypto_engine.wasm')
    ),
  }));

  writeFileSync(
    join(__dirname, 'dist/manifest.json'),
    JSON.stringify(src, null, 2),
    'utf8'
  );
  console.log('  manifest.json → dist/manifest.json (paths rewritten)');
}

// ── HTML rewrite ──────────────────────────────────────────────────────────

/**
 * Copies vault_container.html to dist/ui/ and rewrites the <script src>
 * from the source-relative path to the dist-relative path.
 */
function writeDistHtml() {
  let html = readFileSync(
    join(__dirname, 'src/vault/ui/vault_container.html'), 'utf8'
  );

  // Rewrite script src: any path ending in vault.js → ../vault.js
  // (dist/ui/vault_container.html loading dist/vault.js)
  html = html.replace(
    /src="[^"]*vault\.js"/,
    'src="../vault.js"'
  );

  // Rewrite CSS href: vault_container.css is co-located in dist/ui/
  html = html.replace(
    /href="[^"]*vault_container\.css"/,
    'href="vault_container.css"'
  );

  writeFileSync(join(__dirname, 'dist/ui/vault_container.html'), html, 'utf8');
  console.log('  src/vault/ui/vault_container.html → dist/ui/ (paths rewritten)');
}

// ── Static file copies ────────────────────────────────────────────────────

function copyStatics() {
  // CSS
  copyFileSync(
    join(__dirname, 'src/vault/ui/vault_container.css'),
    join(__dirname, 'dist/ui/vault_container.css')
  );
  console.log('  vault_container.css → dist/ui/');

  // Icons
  for (const size of [16, 48, 128]) {
    const src  = join(__dirname, `assets/icons/${size}.png`);
    const dest = join(__dirname, `dist/assets/icons/${size}.png`);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      console.log(`  assets/icons/${size}.png → dist/assets/icons/`);
    }
  }

  // Promotional images
  const imgSrc = join(__dirname, 'assets/images');
  if (existsSync(imgSrc)) {
    readdirSync(imgSrc).forEach(file => {
      copyFileSync(
        join(imgSrc, file),
        join(__dirname, `dist/assets/images/${file}`)
      );
      console.log(`  assets/images/${file} → dist/assets/images/`);
    });
  }

  // WASM (only if compiled)
  const wasmSrc  = join(__dirname, 'src/wasm/crypto_engine.wasm');
  const wasmDest = join(__dirname, 'dist/wasm/crypto_engine.wasm');
  if (existsSync(wasmSrc)) {
    copyFileSync(wasmSrc, wasmDest);
    console.log('  crypto_engine.wasm → dist/wasm/');
  } else {
    console.warn('  [warn] crypto_engine.wasm not found — WebCrypto fallback will be used');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

console.log('\nCredLock build starting…\n');
ensureDirs();

if (watch) {
  // Write statics once upfront; esbuild handles JS incrementally
  writeDistManifest();
  writeDistHtml();
  copyStatics();

  const ctx = await esbuild.context({
    ...sharedConfig,
    entryPoints: entryPoints.map(e => ({ in: e.in, out: e.out })),
    outdir: '.',
    plugins: [{
      name: 'on-rebuild',
      setup(build) {
        build.onEnd(() => {
          writeDistManifest();
          writeDistHtml();
          copyStatics();
          console.log('\n[watch] rebuild complete\n');
        });
      }
    }],
  });
  await ctx.watch();
  console.log('\nWatching for changes (Ctrl+C to stop)…\n');

} else {
  // One-shot build
  for (const { in: entry, out } of entryPoints) {
    await esbuild.build({
      ...sharedConfig,
      entryPoints: [entry],
      outfile:     `${out}.js`,
    });
  }
  writeDistManifest();
  writeDistHtml();
  copyStatics();
  console.log('\nBuild complete → dist/\n');
}
