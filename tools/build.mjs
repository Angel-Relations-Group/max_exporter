#!/usr/bin/env node
// Builds browser-specific extension packages from a single shared codebase.
//
// The extension source files (background.js, content.js, content.css,
// main-inject.js, popup.html, popup.js, ico.png) are identical for every
// browser — they use the `chrome.*` API namespace which both Chrome and
// Firefox support. The ONLY thing that differs is manifest.json, so this
// script generates two output folders:
//
//   dist/chrome   -> manifest with `background.service_worker`
//   dist/firefox  -> manifest with `background.scripts` + browser_specific_settings
//
// Usage:  node tools/build.mjs
// CI then zips each folder (see .github/workflows/build-zip.yml).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Shared extension files copied verbatim into every target folder.
const SHARED_FILES = [
  'background.js',
  'content.js',
  'content.css',
  'main-inject.js',
  'popup.html',
  'popup.js',
  'ico.png'
];

// Stable add-on id used to sign the Firefox build on AMO. Change this to your
// own id (email or UUID format) before publishing.
const FIREFOX_ADDON_ID = 'max-channel-exporter@arg.tools';
// Firefox 128 is the first release to support `content_scripts[].world:"MAIN"`
// (main-inject.js needs the MAIN world to patch navigator.clipboard.writeText).
const FIREFOX_MIN_VERSION = '128.0';

async function rmrf(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function copySharedFiles(dest) {
  for (const file of SHARED_FILES) {
    const src = path.join(ROOT, file);
    try {
      await fs.access(src);
    } catch {
      throw new Error(`Expected extension file not found: ${file}`);
    }
    await fs.copyFile(src, path.join(dest, file));
  }
}

// Chrome manifest = the source manifest.json unchanged.
function makeChromeManifest(base) {
  return base;
}

// Firefox manifest: replace the service-worker background with an event-page
// script and add the gecko-specific settings Firefox requires for signing.
function makeFirefoxManifest(base) {
  const m = structuredClone(base);
  m.background = { scripts: ['background.js'] };
  m.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ADDON_ID,
      strict_min_version: FIREFOX_MIN_VERSION
    }
  };
  return m;
}

async function buildTarget(name, manifest) {
  const dest = path.join(DIST, name);
  await rmrf(dest);
  await fs.mkdir(dest, { recursive: true });
  await copySharedFiles(dest);
  await fs.writeFile(
    path.join(dest, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  );
  console.log(`✓ built dist/${name} (${name === 'firefox' ? 'Firefox' : 'Chrome'})`);
}

async function main() {
  const baseManifest = JSON.parse(
    await fs.readFile(path.join(ROOT, 'manifest.json'), 'utf8')
  );

  await rmrf(DIST);
  await fs.mkdir(DIST, { recursive: true });

  await buildTarget('chrome', makeChromeManifest(baseManifest));
  await buildTarget('firefox', makeFirefoxManifest(baseManifest));

  console.log('\nNext: zip each folder (CI) or load dist/<browser> unpacked locally.');
}

main().catch((err) => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
