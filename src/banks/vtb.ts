import { createDriver, closeDriver } from '../playwright.js';
import type { PlayDriver } from '../playwright.js';
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
  private driver: PlayDriver | undefined;

  async init(ctx?: BankCollectorContext): Promise<void> {
    this.driver = await createDriver(ctx?.headless !== false);
  }

  async loginAndPrepare(): Promise<void> {
    if (!this.driver) throw new Error('driver not initialized');
    await this.driver.page.goto(VTB_HISTORY_URL);
    await this.driver.page.waitForLoadState('domcontentloaded');

    const phoneEnv = (process.env.TSUNADE__VTB_PHONE ?? '').trim();

    const started = Date.now();
    for (;;) {
      try {
        const hasFail = await this.driver.page.evaluate(() => /произош[ёе]л\s+сбой/i.test(document.body.innerText || ''));
        if (hasFail) await new Promise(() => {});
      } catch {}

      try {
        if (phoneEnv) {
          const phoneInput = await this.driver.page.waitForSelector('input[type="tel"], input[name*="phone"], input[placeholder*="телефон"]', { timeout: 1000 });
          if (phoneInput) {
            try { await phoneInput.fill(''); } catch {}
            await phoneInput.type(phoneEnv);
            try {
              const candidates = await this.driver.page.$$('button, [role="button"]');
              for (const btn of candidates) {
                const txt = (await this.driver.page.evaluate(el => (el as HTMLElement).innerText || '', btn)) as string;
                if (txt && txt.trim().toLowerCase().includes('продолжить')) {
                  await btn.click();
                  break;
                }
              }
            } catch {}
          }
        }
      } catch {}

      try {
        const otpInput = await this.driver.page.waitForSelector('[data-test-id="auth-passcode"] input[name="otpInput"]', { timeout: 1000 });
        if (otpInput) {
          const code = await waitForCodeFromUrl(VTB_GET_CODE_URL, 180000, /^\d{4,8}$/);
          try { await otpInput.fill(''); } catch {}
          await otpInput.type(code);
          try { await fetch(VTB_DELETE_CODE_URL, { method: 'DELETE' }); } catch {}
        }
      } catch {}

      try {
        const pinInput = await this.driver.page.waitForSelector('[data-test-id="passcode"] input[name="codeInput"]', { timeout: 1000 });
        if (pinInput) {
          const pin = (process.env.TSUNADE__VTB_PIN ?? '').trim();
          try { await pinInput.fill(''); } catch {}
          if (pin) await pinInput.type(pin);
        }
      } catch {}

      try {
        const ready = await this.driver.page.evaluate(() => !!document.querySelector('[data-test-id="operationwrapper_operationitemmsa"]'));
        if (ready) break;
      } catch {}

      if (Date.now() - started > 300000) break;
      await this.driver.page.waitForTimeout(500);
    }
  }

  async collectOperations(maxPages?: number, onSnapshot?: (items: BankOperationItem[]) => Promise<void> | void): Promise<BankOperationItem[]> {
    if (!this.driver) throw new Error('driver not initialized');
    const mapper = (items: BankOperationItem[]): BankOperationItem[] => items;
    const items = await collectOperationsVtb(this.driver.page, maxPages ?? 50, async (raw) => {
      if (onSnapshot) await onSnapshot(mapper(raw));
    });
    return mapper(items);
  }

  async shutdown(): Promise<void> {
    await closeDriver(this.driver);
    this.driver = undefined;
  }
}

async function collectOperationsVtb(page: any, maxPages: number, onSnapshot?: (items: BankOperationItem[]) => Promise<void> | void): Promise<BankOperationItem[]> {
  const collected: BankOperationItem[] = [];
  let seen = 0;
  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    try {
      const hasFail = await page.evaluate(() => /произош[ёе]л\s+сбой/i.test(document.body.innerText || ''));
      if (hasFail) await new Promise(() => {});
    } catch {}
    await page.waitForSelector('main');
    const itemsCount: number = await page.evaluate(() => document.querySelectorAll('[data-test-id="operationwrapper_operationitemmsa"]').length);
    for (let i = seen; i < itemsCount; i++) {
      const handles = await page.$$('#[data-test-id="operationwrapper_operationitemmsa"]');
      const btn = handles[i];
      if (!btn) continue;
      await btn.scrollIntoViewIfNeeded();
      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        btn.click(),
      ]);
      const details = await page.evaluate(() => {
        const textContent = (el: Element | null | undefined) => (el?.textContent || '').trim();
        const findPAfter = (root: Element, pred: (s: string) => boolean) => {
          const ps = Array.from(root.querySelectorAll('p'));
          for (const p of ps) {
            const t = textContent(p);
            if (pred(t)) return t;
          }
          return '';
        };
        const h1 = document.querySelector('main h1');
        const title = textContent(h1);
        const allP = Array.from(document.querySelectorAll('main p'));
        let category = '';
        let datetimeText = '';
        let amountText = '';
        for (const p of allP) {
          const t = textContent(p);
          if (!category && t && !t.includes('₽') && /[А-Яа-яA-Za-z]/.test(t) && !/\d{1,2}:\d{2}/.test(t) && !/\d/.test(category)) category = t;
          if (!datetimeText && /\d{1,2}\s+[А-Яа-я]+.*\d{1,2}:\d{2}/.test(t)) datetimeText = t;
          if (!amountText && t.includes('₽')) amountText = t;
        }
        const getDetail = (label: string) => {
          const pList = Array.from(document.querySelectorAll('main p'));
          for (let i = 0; i < pList.length - 1; i++) {
            if (textContent(pList[i]).toLowerCase() === label) return textContent(pList[i + 1]);
          }
          return '';
        };
        const accountName = getDetail('счет списания');
        const counterparty = getDetail('получатель');
        const counterpartyPhone = getDetail('телефон получателя');
        const counterpartyBank = getDetail('банк получателя');
        const message = getDetail('сообщение');
        const fee = getDetail('комиссия');
        const total = getDetail('сумма с учетом комиссии');
        const channel = getDetail('тип перевода');
        const opId = getDetail('идентификатор операции сбп');
        return { title, category, datetimeText, amountText, accountName, counterparty, counterpartyPhone, counterpartyBank, message, fee, total, channel, opId };
      });
      const parseAmount = (s: string): number => {
        const neg = s.includes('–') || s.includes('-');
        const num = s.replace(/[^0-9,.-]/g, '').replace(/,/g, '.');
        const val = Number(num);
        return neg ? -Math.abs(val) : Math.abs(val);
      };
      const m = (details.datetimeText || '').match(/(\d{1,2})\s+([А-Яа-я]+)/);
      const rawDate = m ? `${m[1]} ${m[2]}` : details.datetimeText || '';
      const it: BankOperationItem = {
        date: rawDate,
        text: details.title || '',
        category: details.category || '',
        amount: parseAmount(details.amountText || ''),
        message: details.message || '',
        opTime: '',
        opDateTimeText: details.datetimeText || '',
        opId: details.opId || '',
        accountName: details.accountName || '',
        accountMask: (details.accountName || '').match(/(\d{2}\s?\d{2}$|•\s?\d{4}$)/)?.[0] || '',
        counterparty: details.counterparty || '',
        counterpartyPhone: details.counterpartyPhone || '',
        counterpartyBank: details.counterpartyBank || '',
        feeAmount: parseAmount(details.fee || '0'),
        totalAmount: parseAmount(details.total || '0'),
        channel: details.channel || '',
      };
      collected.push(it);
      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        page.goBack(),
      ]);
      if (onSnapshot && collected.length % 10 === 0) await onSnapshot(collected.slice(-10));
    }
    seen = itemsCount;
    const before: number = await page.evaluate(() => document.querySelectorAll('[data-test-id="operationwrapper_operationitemmsa"]').length);
    await page.evaluate(() => { const s = document.scrollingElement || document.documentElement; s.scrollTop = s.scrollHeight; });
    await page.waitForTimeout(800);
    const after: number = await page.evaluate(() => document.querySelectorAll('[data-test-id="operationwrapper_operationitemmsa"]').length);
    if (after <= before) break;
  }
  if (onSnapshot && collected.length) await onSnapshot(collected.slice(-Math.min(collected.length, 10)));
  return collected;
}
