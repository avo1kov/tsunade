import { chromium, type BrowserContext, type Page } from 'playwright';

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

export type PlayDriver = { context: BrowserContext; page: Page };

export async function createDriver(headless: boolean = true): Promise<PlayDriver> {
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

  const chromeBinary = process.env.TSUNADE__CHROME_BINARY_PATH;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,1600',
    ],
    executablePath: chromeBinary && chromeBinary.trim().length > 0 ? chromeBinary : undefined,
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.setViewportSize({ width: 1280, height: 1600 });
  return { context, page };
}

export async function closeDriver(driver?: PlayDriver): Promise<void> {
  try { await driver?.context.close(); } catch {}
}
