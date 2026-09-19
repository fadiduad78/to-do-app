/* scripts/build-standalone.mjs — generate the single-file build.
 *
 *   node scripts/build-standalone.mjs     (or: npm run build:standalone)
 *
 * Takes public/index.html and inlines everything it references (styles.css,
 * storage.js, cloud.js, notify.js, app.js) so the result runs by
 * double-click, from file://, with no server: IndexedDB/localStorage do the
 * work, the sync layer sees no server and quietly stays in offline mode, and
 * notifications degrade to in-app cards where the origin cannot hold
 * permission (isSecureContext is false on file://). The generated file is
 * COMMITTED, so it must be rebuilt whenever anything under public/ changes —
 * test-ui §15 boots the committed file and fails the suite if it is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'zerotodo-standalone-local.html');

let html = readFileSync(path.join(PUB, 'index.html'), 'utf8');
const missing = [];

const styleTag = html.match(/<link rel="stylesheet" href="([^"]+)">/);
if (styleTag) {
  const css = readFileSync(path.join(PUB, styleTag[1]), 'utf8');
  html = html.replace(styleTag[0], '<style>\n' + css + '\n  </style>');
} else missing.push('stylesheet link not found');

html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  const js = readFileSync(path.join(PUB, src), 'utf8');
  return '<script>\n' + js + '\n</script>';
});
if (!/ZTNotify/.test(html)) missing.push('notify.js was not inlined');

// Web-app-manifest wiring only makes sense when served over https (install +
// OS notifications). Strip the references so the single file stays honest —
// theme-color is harmless and stays.
html = html.replace(/\n *<link rel="manifest"[^>]*>/, '');
html = html.replace(/\n *<link rel="apple-touch-icon"[^>]*>/, '');

if (missing.length) {
  console.error('build-standalone: cannot build — ' + missing.join('; '));
  process.exit(1);
}

const banner = '<!-- GENERATED FILE — do not edit by hand. Source: public/ (index.html + '
  + 'styles.css + storage.js + cloud.js + notify.js + app.js). '
  + 'Regenerate: node scripts/build-standalone.mjs -->\n';
html = html.replace(/^(<!doctype html>\n)/i, '$1' + banner);

writeFileSync(OUT, html);
console.log('zerotodo-standalone-local.html rebuilt:', (html.length / 1024).toFixed(1) + ' KB');
