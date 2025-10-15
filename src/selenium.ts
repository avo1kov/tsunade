import { Builder, By, until, WebDriver, WebElement } from 'selenium-webdriver';

export type QrCaptureResult = {
  screenshotPath: string;
  qrElementRect?: { x: number; y: number; width: number; height: number };
};

export type OperationItem = {
  date: string;
  text: string;
  category: string;
  amount: number;
};

export async function createDriver(headless: boolean = true): Promise<WebDriver> {
  const chrome: any = await import('selenium-webdriver/chrome.js');
  const options = new chrome.Options();
  if (headless) {
    options.addArguments('--headless=new');
  }
  options.addArguments(
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1280,1600'
  );

  const userDataDirEnv = process.env.CHROME_USER_DATA_DIR || '';
  let userDataDir = userDataDirEnv.trim();
  if (!userDataDir) {
    const path = await import('node:path');
    userDataDir = path.resolve(process.cwd(), '.chrome-data');
  }
  try {
    const fs = await import('node:fs/promises');
    await fs.mkdir(userDataDir, { recursive: true });
  } catch {}
  options.addArguments(`--user-data-dir=${userDataDir}`);

  const chromeBinary = process.env.CHROME_BINARY_PATH;
  if (chromeBinary && chromeBinary.trim().length > 0) {
    options.setChromeBinaryPath(chromeBinary);
  }

  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  return driver;
}

export async function navigateToAlfa(driver: WebDriver): Promise<void> {
  // Uses the dashboard URL provided by the user
  const url = 'https://web.alfabank.ru/history/';
  await driver.get(url);
  await driver.wait(async () => (await driver.getTitle()).length >= 0, 15000);
}

export async function waitForQrAndCapture(
  driver: WebDriver,
  timeoutMs: number = 60_000
): Promise<QrCaptureResult> {
  // Try common selectors for QR containers; these may need updates if the site changes
  const qrSelectors = [
    '.qr__container canvas',
    // 'img[alt*="QR" i]',
    // 'canvas[aria-label*="QR" i]',
    // 'img[src*="qr" i]',
    // '[data-testid*="qr" i]',
    // 'svg[role="img"]'
  ];

  let qrElement: WebElement | undefined;
  for (const selector of qrSelectors) {
    try {
      qrElement = await driver.wait(until.elementLocated(By.css(selector)), Math.floor(timeoutMs / qrSelectors.length));
      // Ensure it's visible
      await driver.wait(until.elementIsVisible(qrElement), 5_000);
      break;
    } catch {
      // try next selector
    }
  }

  // Fallback: if not found by selector, wait for any canvas on the page (some QR widgets render to canvas)
  if (!qrElement) {
    try {
      qrElement = await driver.wait(until.elementLocated(By.css('canvas')), 10_000);
      await driver.wait(until.elementIsVisible(qrElement), 5_000);
    } catch {
      // ignore
    }
  }

  const screenshotPath = `./dist/qr-${Date.now()}.png`;
  // Always take a full-page screenshot; some drivers only support viewport
  const imageBase64 = await driver.takeScreenshot();
  const fs = await import('node:fs/promises');
  await fs.mkdir('./dist', { recursive: true });
  await fs.writeFile(screenshotPath, imageBase64, 'base64');

  let rect: QrCaptureResult['qrElementRect'];
  if (qrElement) {
    try {
      const loc = await qrElement.getRect();
      rect = { x: Math.floor(loc.x), y: Math.floor(loc.y), width: Math.floor(loc.width), height: Math.floor(loc.height) };
    } catch {
      // ignore if we cannot read rect
    }
  }

  if (rect) {
    return { screenshotPath, qrElementRect: rect };
  }
  return { screenshotPath };
}

export async function closeDriver(driver?: WebDriver): Promise<void> {
  try {
    if (driver) {
      await driver.quit();
    }
  } catch {
    // ignore
  }
}


export async function collectOperations(
  driver: WebDriver,
  maxClicks: number = 50,
  onSnapshot?: (items: OperationItem[]) => Promise<void> | void
): Promise<OperationItem[]> {
  await driver.wait(until.elementLocated(By.css('[data-test-id="operation-cell-addon"]')), 300000);
  let prevCount = (await driver.findElements(By.css('button[data-test-id="operation-cell"]'))).length;

  const parseAll = async (): Promise<OperationItem[]> => {
    const rawItems: { date: string; text: string; category: string; amountText: string }[] = await driver.executeScript(
      `return (function() {
        function findPrevDate(el) {
          var node = el;
          while (node) {
            var prev = node.previousElementSibling;
            while (prev) {
              if (prev.matches('div.ZfxVc')) {
                var span = prev.querySelector('span');
                return (span ? span.textContent : prev.textContent) || '';
              }
              prev = prev.previousElementSibling;
            }
            node = node.parentElement;
          }
          return '';
        }

        var buttons = Array.from(document.querySelectorAll('button[data-test-id="operation-cell"]'));
        var items = [];
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          var textEl = btn.querySelector('[data-test-id="operation-cell-text_content"]');
          var categoryEl = btn.querySelector('[data-test-id="transaction-category-name"]');
          var statusEl = btn.querySelector('[data-test-id="transaction-status"]');
          var dateText = findPrevDate(btn);
          var text = ((textEl && textEl.textContent) ? textEl.textContent : '').trim();
          var category = ((categoryEl && categoryEl.textContent) ? categoryEl.textContent : '').trim();
          var amountText = ((statusEl && statusEl.textContent) ? statusEl.textContent : '').trim();
          items.push({ date: dateText.trim(), text: text, category: category, amountText: amountText });
        }
        return items;
      })();`
    );

    function parseAmount(s: string): number {
      const val = s || '';
      const minus = /[-−]/.test(val);
      const cleaned = val.replace(/[\s\u00A0\u2007\u202F\uFEFF]/g, '').replace(/[^0-9,.-]/g, '');
      const m = cleaned.match(/([0-9]{1,3}(?:[0-9]+)?)(?:[,\.][0-9]{1,2})?/);
      if (!m) return 0;
      const intPart = m[1] ?? '0';
      const n = parseInt(intPart, 10);
      return minus ? -n : n;
    }

    return rawItems.map(r => ({ date: r.date, text: r.text, category: r.category, amount: parseAmount(r.amountText) }));
  };

  let snapshot = await parseAll();
  if (onSnapshot) await onSnapshot(snapshot);
  for (let i = 0; i < maxClicks; i++) {
    const moreButtons = await driver.findElements(By.xpath("//button[.//span[contains(normalize-space(.), 'Показать ещё')]]"));
    if (moreButtons.length === 0) break;
    const btn = moreButtons[0];
    if (!btn) break;
    try {
      await driver.executeScript('arguments[0].scrollIntoView({block:\'center\'})', btn);
    } catch {}
    await btn.click();
    try {
      await driver.wait(async () => {
        const c = (await driver.findElements(By.css('button[data-test-id="operation-cell"]'))).length;
        if (c > prevCount) {
          prevCount = c;
          return true;
        }
        return false;
      }, 20000);
    } catch {}

    snapshot = await parseAll();
    if (onSnapshot) await onSnapshot(snapshot);
  }
  return snapshot;
}


