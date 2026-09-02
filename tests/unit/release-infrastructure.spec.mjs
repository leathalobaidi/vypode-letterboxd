import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('beta display version is consistent across release-facing files', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const releaseFiles = ['README.md', 'STORE-LISTING.txt', 'content.js', 'popup.html', 'styles.css'];

  assert.equal(manifest.version_name, '6.3.0-beta.7');
  for (const file of releaseFiles) {
    assert.match(read(file), /6\.3\.0-beta\.7/, `${file} should identify beta.7`);
  }
  for (const file of ['STORE-LISTING.txt', 'popup.html', 'styles.css']) {
    assert.doesNotMatch(read(file), /6\.3\.0-beta\.6/, `${file} should not display the previous beta`);
  }
});

test('popup exposes accessible status and actionable control placeholders', () => {
  const popup = read('popup.html');

  assert.match(popup, /<html lang="en-GB">/);
  assert.match(popup, /:focus-visible/);
  assert.match(popup, /prefers-reduced-motion: reduce/);
  for (const id of [
    'popupHealth',
    'popupHealthText',
    'popupPending',
    'popupPendingCount',
    'popupPendingText',
    'resumeSwipeBtn',
    'syncNowBtn',
    'openSettingsBtn'
  ]) {
    assert.match(popup, new RegExp(`id="${id}"`), `${id} is missing`);
  }
  assert.ok((popup.match(/aria-live="polite"/g) || []).length >= 3);
  assert.match(popup, /<kbd>T<\/kbd>/);
  assert.match(popup, /<kbd>K<\/kbd>/);
  assert.match(popup, /<kbd>Space<\/kbd>/);
});

test('store listing explains every requested permission', () => {
  const listing = read('STORE-LISTING.txt');

  assert.match(listing, /storage:\nRequired to store/);
  assert.match(listing, /unlimitedStorage:\nRequired because/);
  assert.match(listing, /Host permission — https:\/\/letterboxd\.com\/\*:/);
  assert.match(listing, /does not grant access to arbitrary files/i);
  assert.match(listing, /Personally identifiable information: YES/);
  assert.match(listing, /Authentication information: YES/);
  assert.match(listing, /Web history: YES/);
  assert.match(listing, /User activity: YES/);
  assert.match(listing, /Letterboxd username/i);
  assert.doesNotMatch(listing, /Personally identifiable information: No/i);
  assert.match(listing, /Host permission — https:\/\/api\.letterboxd\.com\/\*:/);
  assert.match(listing, /LIMITED USE DISCLOSURE:/);
  assert.match(listing, /dist\/swipe-for-letterboxd-v6\.3\.0-beta\.7\.zip/);
  assert.doesNotMatch(listing, /zip the repo root/i);
});

test('release packaging is deterministic and CI publishes its outputs', () => {
  const pkg = JSON.parse(read('package.json'));
  const script = read('scripts/package-extension.sh');
  const workflow = read('.github/workflows/ci.yml');

  assert.equal(pkg.scripts.package, 'sh scripts/package-extension.sh');
  assert.match(script, /zip -X -q/);
  assert.match(script, /touch -t 202001010000\.00/);
  assert.match(script, /shasum -a 256|sha256sum/);
  assert.match(script, /unzip -tq/);
  for (const requiredFile of [
    'manifest.json',
    'background.js',
    'content.js',
    'film-state.js',
    'popup.html',
    'popup.js',
    'styles.css',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png'
  ]) {
    assert.match(script, new RegExp(requiredFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /npm test/);
  assert.ok((workflow.match(/npm run package/g) || []).length >= 2);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test('manual installation uses the runtime-only release asset', () => {
  const readme = read('README.md');

  assert.match(readme, /project's \[Releases\]\(https:\/\/github\.com\/leathalobaidi\/vypode-letterboxd\/releases\)/);
  assert.match(readme, /swipe-for-letterboxd-v<version>\.zip/);
  assert.match(readme, /swipe-for-letterboxd-v<version>\.sha256/);
  assert.match(readme, /Select the unzipped runtime folder containing `manifest\.json`/);
  assert.doesNotMatch(readme, /Click \*\*Code\*\* then \*\*Download ZIP\*\*/);
  assert.doesNotMatch(readme, /vypode-letterboxd-main\/\n/);
  assert.match(readme, /CI verifies this by comparing two independently generated archives on Ubuntu/);
  assert.doesNotMatch(readme, /same SHA-256 checksum on macOS and Linux/);
});
