import puppeteer from 'puppeteer';

const PORT = 4280;
const CODE = process.argv[2];

if (!CODE) {
  console.error('Usage: node screenshot-security.mjs <access-code>');
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

// Open security panel by removing 'hidden' class directly
await page.evaluate(() => {
  const overlay = document.querySelector('.security-overlay, #security-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    console.log('Removed hidden from security overlay');
  }
  // Also try clicking the security toggle
  const btn = document.getElementById('security-toggle');
  if (btn) btn.click();
});
await new Promise(r => setTimeout(r, 1500));

await page.screenshot({ path: 'docs/screenshots/security.png', fullPage: false });
console.log('Saved security.png');

// Help overlay
await page.evaluate(() => {
  const help = document.getElementById('kbd-help');
  if (help) help.classList.remove('hidden');
});
await new Promise(r => setTimeout(r, 1000));
await page.screenshot({ path: 'docs/screenshots/help.png', fullPage: false });
console.log('Saved help.png');

await browser.close();
