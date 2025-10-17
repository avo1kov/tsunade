import { createDriver, closeDriver } from '../playwright.js';
import type { PlayDriver } from '../playwright.js';
import type { BankCollector, BankCollectorContext, BankOperationItem } from './types.js';

const VTB_HISTORY_URL = (process.env.TSUNADE__VTB_HISTORY_URL ?? 'https://online.vtb.ru/history').trim();
const VTB_GET_CODE_URL = (process.env.TSUNADE__VTB_GET_CODE_URL || '').trim();
const VTB_DELETE_CODE_URL = (process.env.TSUNADE__VTB_DELETE_CODE_URL ?? '').trim();

const SEL = {
  passcodeInput: '[data-test-id="passcode"] input[name="codeInput"]',
  otpInput: '[data-test-id="auth-passcode"] input[name="otpInput"]',
  phoneInput: 'input[type="tel"], input[name*="phone"], input[placeholder*="телефон"]',
  listItem: '[data-test-id="operationwrapper_operationitemmsa"]',
  detailsHeader: 'main h1'
} as const;

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
    try { await fetch(VTB_DELETE_CODE_URL, { method: 'DELETE' }); } catch {}

    if (!this.driver) throw new Error('driver not initialized');
    console.log('[vtb] goto', VTB_HISTORY_URL);
    await this.driver.page.goto(VTB_HISTORY_URL);
    await this.driver.page.waitForLoadState('domcontentloaded');
    try { console.log('[vtb] url', await this.driver.page.evaluate(() => location.href)); } catch {}

    const phoneEnv = (process.env.TSUNADE__VTB_PHONE ?? '').trim();

    let didPhone = false;
    let didOtp = false;
    let didPin = false;
    const started = Date.now();
    for (;;) {
      if (await hasFatalError(this.driver.page)) await new Promise(() => {});

      try {
        if (phoneEnv && !didPhone) didPhone = await fillPhoneAndContinue(this.driver.page, phoneEnv);
      } catch {}

      try {
        if (!didOtp) didOtp = await enterOtpIfPresent(this.driver.page);
      } catch {}

      try {
        if (!didPin) didPin = await enterPinIfPresent(this.driver.page);
      } catch {}

      try {
        const ready = await isListReady(this.driver.page);
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
    try { console.log('[vtb] collect page', pageNum); } catch {}

    if (await hasFatalError(page)) await new Promise(() => {});

    await page.waitForSelector('main');

    const itemsCount: number = await getListCount(page);

    try { console.log('[vtb] itemsCount', itemsCount, 'seen', seen); } catch {}

    for (let i = seen; i < itemsCount; i++) {
      const item = await clickAndParseItem(page, i);

      if (item) collected.push(item);
      if (onSnapshot && collected.length % 10 === 0) await onSnapshot(collected.slice(-10));
    }

    seen = itemsCount;

    const before: number = await getListCount(page);

    try { console.log('[vtb] scroll load more, before', before); } catch {}

    await scrollToLoadMore(page);

    const after: number = await getListCount(page);

    try { console.log('[vtb] after', after); } catch {}

    if (after <= before) break;
  }
  if (onSnapshot && collected.length) await onSnapshot(collected.slice(-Math.min(collected.length, 10)));
  return collected;
}

async function hasFatalError(page: any): Promise<boolean> {
  try {
    return await page.evaluate(() => /произош[ёе]л\s+сбой/i.test(document.body.innerText || ''));
  } catch { return false; }
}

async function isListReady(page: any): Promise<boolean> {
  try {
    return await page.evaluate((sel: string) => !!document.querySelector(sel), SEL.listItem);
  } catch { return false; }
}

async function getListCount(page: any): Promise<number> {
  try {
    return await page.evaluate((sel: string) => document.querySelectorAll(sel).length, SEL.listItem);
  } catch { return 0; }
}

async function scrollToLoadMore(page: any): Promise<void> {
  await page.evaluate(() => { const s = document.scrollingElement || document.documentElement; s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(800);
}

async function fillPhoneAndContinue(page: any, phone: string): Promise<boolean> {
  const input = await page.waitForSelector(SEL.phoneInput, { timeout: 1000 }).catch(() => null);
  if (!input) return false;
  try { await input.fill(''); } catch {}
  await input.type(phone);
  try {
    const buttons = await page.$$('button, [role="button"]');
    for (const btn of buttons) {
      const txt = await page.evaluate((el: Element) => (el as HTMLElement).innerText || '', btn);
      if (txt && txt.trim().toLowerCase().includes('продолжить')) { await btn.click(); break; }
    }
  } catch {}
  return true;
}

async function enterOtpIfPresent(page: any): Promise<boolean> {
  const otp = await page.waitForSelector(SEL.otpInput, { timeout: 1000 }).catch(() => null);
  if (!otp) return false;
  const code = await waitForCodeFromUrl(VTB_GET_CODE_URL, 180000, /^\d{4,8}$/);
  try { await otp.fill(''); } catch {}
  await otp.type(code);
  try { await fetch(VTB_DELETE_CODE_URL, { method: 'DELETE' }); } catch {}
  return true;
}

async function enterPinIfPresent(page: any): Promise<boolean> {
  const pinHandle = await page.waitForSelector(SEL.passcodeInput, { timeout: 1000 }).catch(() => null);
  if (!pinHandle) return false;
  const pin = (process.env.TSUNADE__VTB_PIN ?? '').trim();
  try { await pinHandle.fill(''); } catch {}
  if (pin) await pinHandle.type(pin);
  return true;
}

async function clickAndParseItem(page: any, index: number): Promise<BankOperationItem | null> {
  try {
    const items = await page.$$(SEL.listItem);
    const btn = items[index];
    if (!btn) return null;
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
  } catch { return null; }
  try {
    const ok = await page.evaluate((sel: string) => {
      const h = document.querySelector(sel);
      const t = h ? (h.textContent || '').trim() : '';
      return !!h && t.length > 0;
    }, SEL.detailsHeader);
    if (!ok) return null;
  } catch { return null; }
  try {
    const details = await page.evaluate(() => {
      const textContent = (el: Element | null | undefined): string => (el && el.textContent ? el.textContent : '').trim();
      const h1 = document.querySelector('main h1');
      const title = textContent(h1);
      const mainEl = document.querySelector('main') as HTMLElement | null;
      const textAll = mainEl && mainEl.innerText ? mainEl.innerText : '';
      const allP = Array.from(document.querySelectorAll('main p'));
      let category = '';
      let datetimeText = '';
      let amountText = '';
      for (const p of allP) {
        const t = textContent(p);
        if (!category && t && !t.includes('₽') && /[А-Яа-яA-Za-z]/.test(t) && !/\d{1,2}:\d{2}/.test(t)) category = t;
        if (!datetimeText && /\d{1,2}\s+[А-Яа-я]+.*\d{1,2}:\d{2}/.test(t)) datetimeText = t;
        if (!amountText && t.includes('₽')) amountText = t;
      }
      const getDetail = (label: string) => {
        const pList = Array.from(document.querySelectorAll('main p'));
        for (let i = 0; i < pList.length - 1; i++) {
          const a = textContent(pList[i]).toLowerCase();
          if (a === label) return textContent(pList[i + 1]);
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
      return { title, textAll, category, datetimeText, amountText, accountName, counterparty, counterpartyPhone, counterpartyBank, message, fee, total, channel, opId } as any;
    });
    const parseAmount = (s: string): number => {
      const m = s.match(/([+−–-])?\s*(\d[\d\s]*)(?:[\.,](\d{2}))?/);
      if (!m) return 0;
      const sign = (m[1] || '').includes('-') || (m[1] || '').includes('−') || (m[1] || '').includes('–') ? -1 : 1;
      const intPart = (m[2] || '').replace(/\s+/g, '');
      const frac = m[3] || '';
      const numStr = frac ? `${intPart}.${frac}` : intPart;
      const val = Number(numStr);
      return sign * val;
    };
    let category = String(details.category || '').trim();
    const catM = String(details.textAll || '').match(/категория\s+([^\n]+)/i);
    if (catM && catM[1]) category = catM[1].trim();
    if (!category) {
      const cs = String(details.category || '');
      const idx = cs.toLowerCase().indexOf('категория');
      if (idx >= 0) {
        const before = cs.slice(0, idx).trim();
        const after = cs.slice(idx + 'категория'.length).trim();
        category = after || before || cs.trim();
      }
    }
    const dtM = String(details.textAll || '').match(/\d{1,2}\s+[А-Яа-я]+(?:\s+\d{4}\s*г?\.?){0,1}[,\s]+\d{1,2}:\d{2}/);
    const dtResolved = dtM ? dtM[0].trim() : String(details.datetimeText || '');
    const m = dtResolved.match(/(\d{1,2})\s+([А-Яа-я]+)/);
    const rawDate = m ? `${m[1]} ${m[2]}` : dtResolved;
    const item: BankOperationItem = {
      date: rawDate,
      text: String(details.title || ''),
      category,
      amount: parseAmount(String(details.amountText || '')),
      message: String(details.message || ''),
      opTime: '',
      opDateTimeText: dtResolved,
      opId: String(details.opId || ''),
      accountName: String(details.accountName || ''),
      accountMask: String(details.accountName || '').match(/(\d{2}\s?\d{2}$|•\s?\d{4}$)/)?.[0] || '',
      counterparty: String(details.counterparty || ''),
      counterpartyPhone: String(details.counterpartyPhone || ''),
      counterpartyBank: String(details.counterpartyBank || ''),
      feeAmount: parseAmount(String(details.fee || '0')),
      totalAmount: parseAmount(String(details.total || '0')),
      channel: String(details.channel || ''),
    };
    try { console.log('[vtb] parsed', { t: item.text, cat: item.category, dt: item.opDateTimeText, amt: item.amount, id: item.opId }); } catch {}
    return item;
  } catch {
    return null;
  } finally {
    try { await page.evaluate(() => history.back()); } catch {}
    let backWait = 0;
    while (backWait < 10000) {
      const onList = await isListReady(page);
      if (onList) break;
      await page.waitForTimeout(200);
      backWait += 200;
    }
  }
}
