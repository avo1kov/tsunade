import { WebDriver } from 'selenium-webdriver';
import { createDriver, navigateToAlfa, waitForQrAndCapture, collectOperations as collectAlfaOperations, closeDriver } from '../playwright.js';
import type { OperationItem } from '../playwright.js';
import type { BankCollector, BankCollectorContext, BankOperationItem } from './types.js';

export class AlfaCollector implements BankCollector {
  private driver: WebDriver | undefined;

  async init(ctx?: BankCollectorContext): Promise<void> {
    this.driver = await createDriver(ctx?.headless !== false);
  }

  async loginAndPrepare(): Promise<void> {
    if (!this.driver) throw new Error('driver not initialized');
    await navigateToAlfa(this.driver);
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
    const mapper = (items: OperationItem[]): BankOperationItem[] => items.map(i => ({ date: i.date, text: i.text, category: i.category, amount: i.amount }));
    const items = await collectAlfaOperations(this.driver, maxPages ?? 50, async (raw) => {
      if (onSnapshot) await onSnapshot(mapper(raw));
    });
    return mapper(items);
  }

  async shutdown(): Promise<void> {
    await closeDriver(this.driver);
    this.driver = undefined;
  }
}
