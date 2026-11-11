#!/usr/bin/env node
// Evaluate JavaScript in a headless Chrome page and print the JSON result.
// Usage: node eval.js <url|file> --js "<expression>" [options]
//   --js <expr>          expression to evaluate (may be async; must return JSON-serializable)
//   --jsfile <path>      evaluate the contents of a JS file instead
//   --waitfor <js>       waitForFunction expression before evaluating
//   --wait <ms>          settle time after load (default 1000)
//   --timeout <ms>       goto timeout (default 60000)
//   --width N --height N
// Prints "RESULT: <json>" then collected page/console errors. Exit 1 on page errors.
const path = require('path');
const fs = require('fs');
const { launch, watchErrors } = require('./lib.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const target = process.argv[2];
if (!target || target.startsWith('--')) { console.error('usage: eval.js <url|file> --js "expr" | --jsfile f.js [--waitfor expr] [--wait ms]'); process.exit(2); }
const url = /^([a-z]+:)?\/\//i.test(target) || target.startsWith('data:') ? target
  : 'file:///' + path.resolve(target).split(path.sep).join('/');
const expr = arg('jsfile', null) ? fs.readFileSync(arg('jsfile'), 'utf8') : arg('js', 'document.title');

(async () => {
  const browser = await launch({ width: +arg('width', 1280), height: +arg('height', 800) });
  try {
    const page = await browser.newPage();
    const errs = watchErrors(page, []);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: +arg('timeout', 60000) });
    const wf = arg('waitfor', null);
    if (wf) await page.waitForFunction(wf, { timeout: +arg('timeout', 60000) });
    await new Promise(r => setTimeout(r, +arg('wait', 1000)));
    const result = await page.evaluate(`(async()=>{ return (${expr}); })()`);
    console.log('RESULT: ' + JSON.stringify(result, null, 2));
    if (errs.length) { console.log('ERRORS:\n' + errs.join('\n')); process.exitCode = 1; }
    else console.log('NO ERRORS');
  } finally { await browser.close(); }
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
