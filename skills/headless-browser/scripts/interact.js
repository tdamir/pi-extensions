#!/usr/bin/env node
// Drive a page with a small JSON action script in headless Chrome.
// Usage: node interact.js <url|file> --script actions.json [--out final.png] [--width N] [--height N] [--wait ms]
// actions.json = array of steps, each one of:
//   { "wait": 500 }
//   { "waitForFunction": "window.foo!==undefined", "timeout": 10000 }
//   { "click": "#btn" }            (CSS selector)
//   { "clickText": "Submit" }      (click element whose text contains this)
//   { "type": { "selector": "#email", "text": "a@b.c", "clear": true } }
//   { "keys": "Space" }            (puppeteer keyboard string, "+"-separated chords: "Control+a")
//   { "scroll": { "x": 0, "y": 800 } }
//   { "move": { "x": 100, "y": 200 } }   { "down": true }   { "up": true }
//   { "eval": "document.title" }   (logged as STEP n EVAL: result)
//   { "screenshot": "step3.png" }
//   { "waitForSelector": "#toast", "timeout": 5000 }
// After all steps: screenshot to --out (default interact-final.png) + error report.
const path = require('path');
const fs = require('fs');
const { launch, watchErrors } = require('./lib.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const target = process.argv[2];
if (!target || target.startsWith('--')) { console.error('usage: interact.js <url|file> --script actions.json [--out f.png]'); process.exit(2); }
const url = /^([a-z]+:)?\/\//i.test(target) || target.startsWith('data:') ? target
  : 'file:///' + path.resolve(target).split(path.sep).join('/');
const steps = JSON.parse(fs.readFileSync(arg('script', 'actions.json'), 'utf8'));

(async () => {
  const browser = await launch({ width: +arg('width', 1280), height: +arg('height', 800) });
  try {
    const page = await browser.newPage();
    const errs = watchErrors(page, []);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: +arg('timeout', 60000) });
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.wait) await new Promise(r => setTimeout(r, s.wait));
      else if (s.waitForFunction) await page.waitForFunction(s.waitForFunction, { timeout: s.timeout || 10000 });
      else if (s.waitForSelector) await page.waitForSelector(s.waitForSelector, { timeout: s.timeout || 10000 });
      else if (s.click) await page.click(s.click);
      else if (s.clickText) await page.evaluate(t => {
        const el = [...document.querySelectorAll('button,a,[role=button],li,div,span')]
          .find(e => e.textContent.trim().includes(t) && e.offsetParent !== null);
        if (!el) throw new Error('clickText not found: ' + t);
        el.click();
      }, s.clickText);
      else if (s.type) {
        if (s.type.clear !== false) await page.$eval(s.type.selector, e => { e.value = ''; });
        await page.type(s.type.selector, s.type.text, { delay: s.type.delay || 0 });
      }
      else if (s.keys) {
        if (s.keys.includes('+')) {
          const [mod, key] = s.keys.split('+');
          await page.keyboard.down(mod); await page.keyboard.press(key); await page.keyboard.up(mod);
        } else await page.keyboard.press(s.keys);
      }
      else if (s.scroll) await page.evaluate((x, y) => window.scrollBy(x, y), s.scroll.x || 0, s.scroll.y || 0);
      else if (s.move) await page.mouse.move(s.move.x, s.move.y);
      else if (s.down) await page.mouse.down();
      else if (s.up) await page.mouse.up();
      else if (s.eval) console.log(`STEP ${i} EVAL:`, JSON.stringify(await page.evaluate(`(async()=>(${s.eval}))()`)));
      else if (s.screenshot) await page.screenshot({ path: s.screenshot, fullPage: !!s.fullPage });
      else console.log('STEP', i, 'unknown:', JSON.stringify(s));
    }
    await new Promise(r => setTimeout(r, +arg('wait', 300)));
    await page.screenshot({ path: arg('out', 'interact-final.png') });
    console.log('saved', arg('out', 'interact-final.png'));
    if (errs.length) { console.log('ERRORS:\n' + errs.join('\n')); process.exitCode = 1; }
    else console.log('NO ERRORS');
  } finally { await browser.close(); }
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
