// Shared launcher for headless-browser skill scripts.
// Uses installed Chrome/Edge + puppeteer-core (from the package root's
// node_modules, or this skill's own when installed standalone; no browser download).
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  throw new Error('No Chrome/Edge found. Set CHROME_PATH=/path/to/chrome(.exe)');
}

// Flags: SwiftShader WebGL so three.js/WebGL pages render in headless too.
// Background-throttling flags keep rAF running for headless screenshots.
function defaultArgs(opts = {}) {
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  ];
  if (opts.webgl !== false) {
    args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  }
  return args.concat(opts.args || []);
}

async function launch(opts = {}) {
  return puppeteer.launch({
    executablePath: opts.executablePath || findChrome(),
    args: defaultArgs(opts),
    defaultViewport: { width: opts.width || 1280, height: opts.height || 800, deviceScaleFactor: opts.dpr || 1 },
    ...(opts.launch || {}),
  });
}

// collect console errors / page errors / failed requests
function watchErrors(page, bag) {
  page.on('pageerror', e => bag.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') bag.push('CONSOLE: ' + m.text().slice(0, 300)); });
  page.on('requestfailed', r => bag.push('REQFAIL: ' + r.url().slice(0, 120) + ' ' + ((r.failure() || {}).errorText || '')));
  return bag;
}

module.exports = { launch, watchErrors, findChrome };
