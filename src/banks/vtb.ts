import { WebDriver, until, By } from 'selenium-webdriver';
import { createDriver, waitForQrAndCapture, closeDriver, collectOperationsVtb } from '../selenium.js';
import type { BankCollector, BankCollectorContext, BankOperationItem } from './types.js';

const VTB_HISTORY_URL = (process.env.TSUNADE__VTB_HISTORY_URL ?? 'https://online.vtb.ru/history').trim();
const VTB_GET_CODE_URL = (process.env.TSUNADE__VTB_GET_CODE_URL || '').trim();
const VTB_DELETE_CODE_URL = (process.env.TSUNADE__VTB_DELETE_CODE_URL ?? '').trim();

async function waitForCodeFromUrl(url: string, timeoutMs: number = 180000, pattern: RegExp = /\b\d{4,8}\b/): Promise<string> {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for code');
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const text = (await res.text()).trim();
      const m = text.match(pattern);
      if (m && m[0]) return m[0];
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
}

export class VtbCollector implements BankCollector {
  private driver: WebDriver | undefined;

  async init(ctx?: BankCollectorContext): Promise<void> {
    this.driver = await createDriver(ctx?.headless !== false);
  }

  async loginAndPrepare(): Promise<void> {
    if (!this.driver) throw new Error('driver not initialized');
    await this.driver.get(VTB_HISTORY_URL);
    await this.driver.wait(async () => (await this.driver!.getTitle()).length >= 0, 15000);
    try {
      console.log('Waiting for passcode input');
      const input = await this.driver.wait(until.elementLocated(By.css('[data-test-id="passcode"] input[name="codeInput"]')), 5000);
      try { await input.clear(); } catch {}
      const pin = (process.env.TSUNADE__VTB_PIN ?? '').trim();
      if (pin) {
        await input.sendKeys(pin);
      }
    } catch {
        console.log('PIN code fail')
    }

    try {
      const otpInput = await this.driver.wait(until.elementLocated(By.css('[data-test-id="auth-passcode"] input[name="otpInput"]')), 15000);
      console.log('Waiting for SMS code input');
      const code = await waitForCodeFromUrl(VTB_GET_CODE_URL, 180000, /^\d{4,8}$/);
      const readlineMod: any = await import('node:readline/promises');
    //   const rl = readlineMod.createInterface({ input: process.stdin, output: process.stdout });
    //   const typed = String((await rl.question(`Код "${code}". Enter чтобы подтвердить или введите другой: `)) || '').trim();
    //   try { await rl.close(); } catch {}
      const finalCode = code;
      try { await otpInput.clear(); } catch {}
      await otpInput.sendKeys(finalCode);
      console.log('SMS код введён');
      try { await fetch(VTB_DELETE_CODE_URL, { method: 'DELETE' }); } catch {}
    } catch {
        console.log('SMS code fail')
    }
  }

  async captureLoginQr(timeoutMs?: number): Promise<{ screenshotPath: string; x?: number; y?: number; width?: number; height?: number }> {
    if (!this.driver) throw new Error('driver not initialized');
    const r = await waitForQrAndCapture(this.driver, timeoutMs ?? 60_000);
    const base = { screenshotPath: r.screenshotPath } as { screenshotPath: string; x?: number; y?: number; width?: number; height?: number };
    if (r.qrElementRect) {
      base.x = r.qrElementRect.x;
      base.y = r.qrElementRect.y;
      base.width = r.qrElementRect.width;
      base.height = r.qrElementRect.height;
    }
    return base;
  }

  async collectOperations(maxPages?: number, onSnapshot?: (items: BankOperationItem[]) => Promise<void> | void): Promise<BankOperationItem[]> {
    if (!this.driver) throw new Error('driver not initialized');
    const mapper = (items: BankOperationItem[]): BankOperationItem[] => items;
    const items = await collectOperationsVtb(this.driver, maxPages ?? 50, async (raw) => {
      if (onSnapshot) await onSnapshot(mapper(raw));
    });
    return mapper(items);
  }

  async shutdown(): Promise<void> {
    await closeDriver(this.driver);
    this.driver = undefined;
  }
}
