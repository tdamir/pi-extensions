#!/usr/bin/env node
// Screenshot a URL or local file with headless Chrome.
// Usage: node shot.js <url|file> [options]
//   --out <png>        output file (default shot.png)
//   --width 1280 --height 800
//   --full             full-page screenshot
//   --waitfor <js>     waitForFunction expression (e.g. "window.APP!==undefined")
//   --wait <ms>        extra settle time after load (default 1000)
//   --timeout <ms>     goto timeout (default 60000)
//   --no-webgl         disable SwiftShader WebGL flags
// Prints collected page/console errors after the shot. Exit code 1 if errors.
const path = require('path');
const { launch, watchErrors } = require('./lib.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = name => process.argv.includes('--' + name);
const target = process.argv[2];
if (!target || target.startsWith('--')) { console.error('usage: shot.js <url|file> [--out f.png] [--width N] [--height N] [--full] [--waitfor expr] [--wait ms] [--timeout ms]'); process.exit(2); }
const url = /^([a-z]+:)?\/\//i.test(target) || target.startsWith('data:') ? target
  : 'file:///' + path.resolve(target).split(path.sep).join('/');

(async () => {
  const browser = await launch({
    width: +arg('width', 1280), height: +arg('height', 800), webgl: !has('no-webgl'),
  });
  try {
    const page = await browser.newPage();
    const errs = watchErrors(page, []);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: +arg('timeout', 60000) });
    const wf = arg('waitfor', null);
    if (wf) await page.waitForFunction(wf, { timeout: +arg('timeout', 60000) });
    await new Promise(r => setTimeout(r, +arg('wait', 1000)));
    await page.screenshot({ path: arg('out', 'shot.png'), fullPage: has('full') });
    console.log('saved', arg('out', 'shot.png'));
    if (errs.length) { console.log('ERRORS:\n' + errs.join('\n')); process.exitCode = 1; }
    else console.log('NO ERRORS');
  } finally { await browser.close(); }
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
