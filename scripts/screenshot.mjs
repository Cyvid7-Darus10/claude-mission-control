import puppeteer from 'puppeteer';

const PORT = 4280;
const CODE = process.argv[2];

if (!CODE) {
  console.error('Usage: node screenshot.mjs <access-code>');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

// Login
await page.goto(`http://localhost:${PORT}/login`);
await page.waitForSelector('input');
await page.type('input', CODE);
// Wait for auto-submit and redirect
await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});

// Wait for dashboard to load and WebSocket data to arrive
await page.waitForSelector('.agent-row, .empty-state', { timeout: 5000 }).catch(() => {});
await new Promise(r => setTimeout(r, 2000));

// Take screenshot
await page.screenshot({
  path: 'docs/screenshots/dashboard.png',
  fullPage: false,
});

console.log('Screenshot saved to docs/screenshots/dashboard.png');

await browser.close();
