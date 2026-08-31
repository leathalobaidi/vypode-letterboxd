import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('manifest is local-first and has only required Chrome permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version, 'manifest.json and package.json versions must match');
  assert.equal(manifest.version_name, '6.3.0-beta.1');
  assert.deepEqual(manifest.permissions, ['storage', 'unlimitedStorage']);
  assert.equal('oauth2' in manifest, false);
  assert.equal('web_accessible_resources' in manifest, false);
  assert.equal(manifest.permissions.includes('identity'), false);
  assert.equal(manifest.permissions.includes('alarms'), false);
});

test('all manifest referenced extension files exist', () => {
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap(script => [...script.js, ...script.css])
  ];

  for (const file of files) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} is missing`);
  }
});

test('downloaded kit does not ship unfinished cloud/OAuth artifacts', () => {
  const forbiddenFiles = ['supabase-setup.sql', 'inject-capture.js'];
  for (const file of forbiddenFiles) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `${file} should not ship`);
  }

  const releaseText = [
    fs.readFileSync(path.join(root, 'README.md'), 'utf8'),
    fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'),
    fs.readFileSync(path.join(root, 'background.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'content.js'), 'utf8')
  ].join('\n');

  assert.equal(/Sign in with Google|chrome\.identity|Supabase|SUPABASE|oauth2|chrome\.alarms/.test(releaseText), false);
});
