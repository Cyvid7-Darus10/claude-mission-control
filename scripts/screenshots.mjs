import puppeteer from 'puppeteer';

const PORT = 4280;
const CODE = process.argv[2];

if (!CODE) {
  console.error('Usage: node screenshots.mjs <access-code>');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

// Login
await page.goto(`http://localhost:${PORT}/login`);
await page.waitForSelector('input');
await page.type('input', CODE);
await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
await page.waitForSelector('.agent-row, .empty-state', { timeout: 5000 }).catch(() => {});
await new Promise(r => setTimeout(r, 2000));

// 1. Full dashboard
await page.screenshot({ path: 'docs/screenshots/dashboard.png', fullPage: false });
console.log('1/4 dashboard.png');

// 2. Login page
const page2 = await browser.newPage();
await page2.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page2.goto(`http://localhost:${PORT}/login`);
await new Promise(r => setTimeout(r, 1000));
await page2.screenshot({ path: 'docs/screenshots/login.png', fullPage: false });
console.log('2/4 login.png');
await page2.close();

// 3. Security panel — press 's' to toggle it
await page.keyboard.press('s');
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: 'docs/screenshots/security.png', fullPage: false });
console.log('3/4 security.png');

// 4. Help overlay — press '?' to toggle
await page.keyboard.press('s'); // close security first
await new Promise(r => setTimeout(r, 500));
await page.keyboard.press('?');
await new Promise(r => setTimeout(r, 1000));
await page.screenshot({ path: 'docs/screenshots/help.png', fullPage: false });
console.log('4/4 help.png');

await browser.close();
console.log('All screenshots saved to docs/screenshots/');
