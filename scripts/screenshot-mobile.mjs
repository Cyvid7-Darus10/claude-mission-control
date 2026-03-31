import puppeteer from 'puppeteer';

const PORT = 4280;
const CODE = process.argv[2];

if (!CODE) {
  console.error('Usage: node screenshot-mobile.mjs <access-code>');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: true });

// iPhone 14 Pro dimensions
const MOBILE_W = 393;
const MOBILE_H = 852;

async function loginAndScreenshot(page, name, opts = {}) {
  await page.goto(`http://localhost:${PORT}/login`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('input');
  await page.type('input', CODE);
  await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  if (opts.clickTab) {
    // Click a mobile tab
    const tabs = await page.$$('.mobile-tab');
    for (const tab of tabs) {
      const text = await tab.evaluate(el => el.textContent);
      if (text.includes(opts.clickTab)) {
        await tab.click();
        await new Promise(r => setTimeout(r, 500));
        break;
      }
    }
  }

  if (opts.evaluate) {
    await page.evaluate(opts.evaluate);
    await new Promise(r => setTimeout(r, 500));
  }

  await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: false });
  console.log(`Saved ${name}.png`);
}

// Mobile: Agents view
const page1 = await browser.newPage();
await page1.setViewport({ width: MOBILE_W, height: MOBILE_H, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await loginAndScreenshot(page1, 'mobile-agents', { clickTab: 'Agents' });
await page1.close();

// Mobile: Timeline view
const page2 = await browser.newPage();
await page2.setViewport({ width: MOBILE_W, height: MOBILE_H, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await loginAndScreenshot(page2, 'mobile-timeline', { clickTab: 'Timeline' });
await page2.close();

// Mobile: Missions view
const page3 = await browser.newPage();
await page3.setViewport({ width: MOBILE_W, height: MOBILE_H, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await loginAndScreenshot(page3, 'mobile-missions', { clickTab: 'Missions' });
await page3.close();

// Mobile: Login
const page4 = await browser.newPage();
await page4.setViewport({ width: MOBILE_W, height: MOBILE_H, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page4.goto(`http://localhost:${PORT}/login`, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1000));
await page4.screenshot({ path: 'docs/screenshots/mobile-login.png', fullPage: false });
console.log('Saved mobile-login.png');
await page4.close();

await browser.close();
console.log('All mobile screenshots saved');
