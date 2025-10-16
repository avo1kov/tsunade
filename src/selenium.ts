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

  const userDataDirEnv = process.env.TSUNADE__CHROME_USER_DATA_DIR || process.env.CHROME_USER_DATA_DIR || '';
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

  const chromeBinary = process.env.TSUNADE__CHROME_BINARY_PATH;
  if (chromeBinary && chromeBinary.trim().length > 0) {
    options.setChromeBinaryPath(chromeBinary);
  }

  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  return driver;
}

export async function navigateToAlfa(driver: WebDriver): Promise<void> {
  // Uses the dashboard URL provided by the user
  const url = (process.env.TSUNADE__ALFA_HISTORY_URL ?? 'https://web.alfabank.ru/history/').trim();
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


export async function collectOperationsVtb(
  driver: WebDriver,
  maxPages: number = 50,
  onSnapshot?: (items: OperationItem[]) => Promise<void> | void
): Promise<OperationItem[]> {
  await driver.wait(until.elementLocated(By.css('button[data-test-id^="operationwrapper_operationitem"]')), 300000);
  let prevCount = (await driver.findElements(By.css('button[data-test-id^="operationwrapper_operationitem"]'))).length;
  let prevSnapshotLen = 0;

  const parseAll = async (): Promise<OperationItem[]> => {
    const rawItems: { date: string; text: string; category: string; amountText: string; messageText: string }[] = await driver.executeScript(
      `return (function() {
        function getNearestHeaderText(el) {
          var node = el;
          while (node) {
            var prev = node.previousElementSibling;
            while (prev) {
              if (prev.querySelector && prev.querySelector('h2')) {
                var h2 = prev.querySelector('h2');
                if (h2) {
                  for (var i = 0; i < h2.childNodes.length; i++) {
                    var cn = h2.childNodes[i];
                    if (cn.nodeType === Node.TEXT_NODE) {
                      var t = cn.textContent || '';
                      t = t.replace(/[\s\u00A0\u2007\u202F\uFEFF]+$/g, '');
                      if (t.trim()) return t.trim();
                    }
                  }
                  return (h2.textContent || '').trim();
                }
              }
              prev = prev.previousElementSibling;
            }
            node = node.parentElement;
          }
          return '';
        }

        var buttons = Array.from(document.querySelectorAll('button[data-test-id^="operationwrapper_operationitem"]'));
        var items = [];
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          var categoryEl = btn.querySelector('[data-role="detail"]');
          var amountEl = btn.querySelector('p[aria-hidden="true"][data-position="right"]');
          if (!amountEl) {
            var allPForAmount = Array.from(btn.querySelectorAll('p'));
            amountEl = allPForAmount.find(function(p){
              var t = (p.textContent || '').trim();
              if (!t) return false;
              var hasDigit = /\d/.test(t);
              var looksMoney = /[₽]|\bр\.?$/i.test(t) || /[\d\s,.]+$/.test(t);
              return hasDigit && looksMoney;
            }) || null;
          }
          var candidates = Array.from(btn.querySelectorAll('p, span'));
          if (amountEl) candidates = candidates.filter(function(n){ return n !== amountEl && !n.contains(amountEl); });
          if (categoryEl) candidates = candidates.filter(function(n){ return n !== categoryEl && !categoryEl.contains(n); });
          candidates = candidates.filter(function(n){ var t = (n.textContent || '').trim(); return t.length > 0; });
          var titleEl = candidates[0] || null;
          var messageEl = null;
          if (candidates.length > 1) {
            for (var j = 1; j < candidates.length; j++) {
              var t1 = (titleEl && titleEl.textContent ? titleEl.textContent : '').trim();
              var t2 = (candidates[j].textContent || '').trim();
              if (t2 && t2 !== t1) { messageEl = candidates[j]; break; }
            }
          }
          var dateText = getNearestHeaderText(btn);
          var text = ((titleEl && titleEl.textContent) ? titleEl.textContent : '').trim();
          var category = ((categoryEl && categoryEl.textContent) ? categoryEl.textContent : '').trim();
          var amountText = ((amountEl && amountEl.textContent) ? amountEl.textContent : '').trim();
          var messageText = ((messageEl && messageEl.textContent) ? messageEl.textContent : '').trim();
          items.push({ date: dateText, text: text, category: category, amountText: amountText, messageText: messageText });
        }
        return items;
      })();`
    );

    function parseAmount(val: string): number {
      var s = val || '';
      var minus = /[-−–]/.test(s);
      var cleaned = s.replace(/[\s\u00A0\u2007\u202F\uFEFF]/g, '').replace(/[^0-9,.-]/g, '');
      var m = cleaned.match(/([0-9]{1,3}(?:[0-9]+)?)(?:[,\.][0-9]{1,2})?/);
      if (!m) return 0;
      var intPart = m[1] || '0';
      var n = parseInt(intPart, 10);
      return minus ? -n : n;
    }

    return rawItems.map(function(r){ var combined = r.messageText ? (r.text ? r.text + ' — ' + r.messageText : r.messageText) : r.text; return { date: r.date, text: combined, category: r.category, amount: parseAmount(r.amountText) }; });
  };

  let snapshot = await parseAll();
  if (onSnapshot) await onSnapshot(snapshot);
  for (let i = prevSnapshotLen; i < snapshot.length; i++) {
    const it = snapshot[i];
    console.log(`[vtb] ${it?.date} ${it?.amount} ${it?.text} [${it?.category}]`);
  }
  prevSnapshotLen = snapshot.length;
  const maxScrolls = Math.max(0, maxPages);
  const waitForIncrease = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const c = (await driver.findElements(By.css('button[data-test-id^="operationwrapper_operationitem"]'))).length;
      if (c > prevCount) {
        prevCount = c;
        return true;
      }
      await driver.sleep(120);
    }
    return false;
  };

  let noIncreaseStreak = 0;
  for (let i = 0; i < maxScrolls; i++) {
    try {
      await driver.executeScript(`(function(){
        var list = Array.from(document.querySelectorAll('button[data-test-id^="operationwrapper_operationitem"]'));
        if (list.length) {
          var last = list[list.length - 1];
          var node = last.parentElement;
          var scroller = null;
          while (node) {
            var style = window.getComputedStyle(node);
            var overY = style.overflowY;
            if (node.scrollHeight > node.clientHeight + 5 && overY && overY !== 'visible') { scroller = node; break; }
            node = node.parentElement;
          }
          if (scroller) { scroller.scrollTop = scroller.scrollHeight; return 'container'; }
        }
        if (document.scrollingElement) { document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight; return 'doc'; }
        window.scrollTo(0, document.body.scrollHeight); return 'win';
      })();`);
    } catch {}
    try {
      const moreButtons = await driver.findElements(By.xpath("//button[.//span[contains(normalize-space(.), 'Показать ещё')]]"));
      if (moreButtons.length > 0) {
        const btn = moreButtons[0];
        try { await driver.executeScript('arguments[0].scrollIntoView({block:\'center\'})', btn); } catch {}
        await btn?.click();
      }
    } catch {}
    const increased = await waitForIncrease(5000);
    snapshot = await parseAll();
    if (onSnapshot) await onSnapshot(snapshot);
    for (let k = prevSnapshotLen; k < snapshot.length; k++) {
      const it = snapshot[k];
      console.log(`[vtb] ${it?.date} ${it?.amount} ${it?.text} [${it?.category}]`);
    }
    prevSnapshotLen = snapshot.length;
    if (!increased) {
      noIncreaseStreak++;
      if (noIncreaseStreak >= 2) break;
    } else {
      noIncreaseStreak = 0;
    }
  }
  return snapshot;
}
