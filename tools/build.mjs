#!/usr/bin/env node
// Builds browser-specific extension packages from a shared codebase.
//
// Most extension files (content.js, content.css, main-inject.js, popup.html,
// popup.js, ico.png) are identical for every browser — they use the `chrome.*`
// API namespace which both Chrome and Firefox support. Two things differ per
// browser, so this script generates two output folders:
//
//   dist/chrome   -> source manifest (MV3 service_worker) +
//                    background.chrome.js copied in as background.js
//   dist/firefox  -> manifest (event-page scripts + gecko id/min version) +
//                    background.firefox.js copied in as background.js
//
// The background script is browser-specific: the Chrome MV3 service worker has
// no URL.createObjectURL (uses a data: URL), while Firefox's event page has it
// and uses a blob: URL (Firefox blocks data: downloads). Each target therefore
// ships only the background code that belongs to it.
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
  'content.js',
  'content.css',
  'main-inject.js',
  'popup.html',
  'popup.js',
  'ico.png'
];

// Browser-specific background script source for each target. Each is copied
// into its output folder as background.js, so the manifest reference
// (service_worker / scripts) resolves regardless of target. The sources are
// named per browser (background.chrome.js / background.firefox.js) for clarity.
const BACKGROUND_SOURCE = {
  chrome: 'background.chrome.js',
  firefox: 'background.firefox.js'
};

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

  // Firefox manifest: add the gecko-specific settings Firefox requires for signing.
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

  // Copy only this browser's background script, renamed to background.js so the
  // manifest reference resolves regardless of target.
  const bgFile = BACKGROUND_SOURCE[name];
  const bgSrc = path.join(ROOT, bgFile);
  try {
    await fs.access(bgSrc);
  } catch {
    throw new Error(`Expected background script not found: ${bgFile}`);
  }
  await fs.copyFile(bgSrc, path.join(dest, 'background.js'));

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
