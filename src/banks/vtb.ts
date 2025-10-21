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
  detailsHeader: 'main h1',
  backToLoginBtn: '[data-test-id="back-to-login_button"]'
} as const;

async function humanPause(page: any, base: number = 200, jitter: number = 300): Promise<void> {
  const ms = base + Math.floor(Math.random() * jitter);
  await page.waitForTimeout(ms);
}

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
      if (await handleReauthIfError(this.driver.page)) {
        didPhone = false;
        didOtp = false;
        didPin = false;
        try { await this.driver.page.waitForLoadState('domcontentloaded'); } catch {}
        await this.driver.page.waitForTimeout(500);
        continue;
      }

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
      try { console.log('[vtb] loginAndPrepare:loop', { didPhone, didOtp, didPin }); } catch {}
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

type GeneralSeenItem = { text: string, seen: boolean, y?: number, loc?: any };

async function collectOperationsVtb(page: any, maxPages: number, onSnapshot?: (items: BankOperationItem[]) => Promise<void> | void): Promise<BankOperationItem[]> {
  const collected: BankOperationItem[] = [];
  const generalSeen: GeneralSeenItem[] = [];

  if (await handleReauthIfError(page)) {
    try { console.log('[vtb] reauth triggered during collect, stopping collect'); } catch {}
    return [];
  }

  await page.waitForSelector('main');

  while (true) {
    let nextIndexToCollect = -1;
    let lastSnapshot: GeneralSeenItem[] = [];
    for (let k = 0; k < 3; k++) {
      await humanPause(page, 1000, 1500);
      lastSnapshot = await getGeneralSeenSnapshot(page);
      generalSeen.push(...extendGeneralSeen(generalSeen, lastSnapshot));
      nextIndexToCollect = getNextIndexToCollect(generalSeen, lastSnapshot);

      if (nextIndexToCollect > -1) break;
    }

    if (nextIndexToCollect < 0) break;

    // Refresh handle/y from the latest snapshot to avoid DOM drift/virtualization issues
    const gs = generalSeen[nextIndexToCollect]!;
    const jFromSnap = (typeof gs.y === 'number') ? findIndexByY(lastSnapshot, gs.y as number) : -1;
    if (jFromSnap >= 0) {
      try {
        gs.loc = lastSnapshot[jFromSnap]!.loc;
        if (typeof lastSnapshot[jFromSnap]!.y === 'number') gs.y = lastSnapshot[jFromSnap]!.y;
      } catch {}
    }
    const targetText = gs?.text || '';
    // Prefer the exact handle from the same snapshot to avoid DOM drift
    const handle = gs?.loc;
    let locOrHandle: any | null = null;
    if (handle) {
      try {
        const connected = await handle.evaluate((el: Element) => (el as HTMLElement).isConnected === true);
        if (connected) locOrHandle = handle;
      } catch {}
    }
    if (!locOrHandle) {
      if (targetText) {
        const keyParts = pickKeyPartsForMatch(targetText);
        let loc = page.locator(SEL.listItem);
        for (const part of keyParts) {
          const re = new RegExp(escapeForRegex(part).replace(/\s+/g, '\\s+'), 'i');
          loc = loc.filter({ hasText: re });
        }
        locOrHandle = loc.first();
      } else {
        locOrHandle = page.locator(SEL.listItem).nth(nextIndexToCollect);
      }
    }
    const targetY = gs?.y ?? undefined;

    const item = await clickAndParseItem(page, locOrHandle, targetY);

    if (item) {
      collected.push(item);
      if (onSnapshot && collected.length % 10 === 0) await onSnapshot(collected.slice(-10));
    }
    generalSeen[nextIndexToCollect]!.seen = true;
  }

  if (onSnapshot && collected.length) await onSnapshot(collected.slice(-Math.min(collected.length, 10)));
  return collected;
}

async function hasFatalError(page: any): Promise<boolean> {
  try {
    return await page.evaluate(() => /произош[ёе]л\s+сбой/i.test(document.body.innerText || ''));
  } catch { return false; }
}

async function handleReauthIfError(page: any): Promise<boolean> {
  let fatal = false;
  try { fatal = await hasFatalError(page); } catch { fatal = false; }
  if (!fatal) return false;
  try { console.log('[vtb] fatal error detected, attempting back-to-login'); } catch {}
  try {
    const btn = await page.waitForSelector(SEL.backToLoginBtn, { timeout: 1500 }).catch(() => null);
    if (btn) {
      await humanPause(page, 120, 240);
      try { await btn.click({ timeout: 1000 }); } catch {}
      try { await page.waitForLoadState('domcontentloaded'); } catch {}
      await humanPause(page, 150, 300);
      return true;
    }
  } catch {}
  try {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button')) as HTMLElement[];
      const target = btns.find(b => /вернуться\s+к\s+входу/i.test((b.textContent || '').trim()));
      if (target) { target.click(); return true; }
      return false;
    });
    if (clicked) {
      try { await page.waitForLoadState('domcontentloaded'); } catch {}
      await humanPause(page, 150, 300);
      return true;
    }
  } catch {}
  return false;
}

async function isListReady(page: any): Promise<boolean> {
  try {
    return await page.evaluate((sel: string) => !!document.querySelector(sel), SEL.listItem);
  } catch { return false; }
}

type ListSnapshot = { texts: string[], locs: any[], ys: number[] };

async function getListSnapshot(page: any): Promise<ListSnapshot> {
  try {
    const rowLocator = page.locator(SEL.listItem);
    const count = await rowLocator.count();
    const texts: string[] = [];
    const locs: any[] = [];
    const ys: number[] = [];
    for (let i = 0; i < count; i++) {
      const handle = await rowLocator.nth(i).elementHandle();
      if (!handle) continue;
      const { text, y } = (await handle.evaluate((el: Element) => {
        const t = ((el as HTMLElement).innerText || '').trim();
        const rect = (el as HTMLElement).getBoundingClientRect();
        const absY = Math.max(0, rect.top + (window.scrollY || window.pageYOffset || 0));
        return { text: t, y: absY };
      })) as { text: string, y: number };
      if (text.length === 0) continue;
      texts.push(text);
      locs.push(handle);
      ys.push(y);
    }
    return { texts, locs, ys };
  } catch { return { texts: [], locs: [], ys: [] }; }
}

// Returns an array of GeneralSeenItem built from the current list snapshot
async function getGeneralSeenSnapshot(page: any): Promise<GeneralSeenItem[]> {
  try {
    const rowLocator = page.locator(SEL.listItem);
    const count = await rowLocator.count();
    const out: GeneralSeenItem[] = [];
    for (let i = 0; i < count; i++) {
      const handle = await rowLocator.nth(i).elementHandle();
      if (!handle) continue;
      const { text, y } = (await handle.evaluate((el: Element) => {
        const t = ((el as HTMLElement).innerText || '').trim();
        const rect = (el as HTMLElement).getBoundingClientRect();
        const absY = Math.max(0, rect.top + (window.scrollY || window.pageYOffset || 0));
        return { text: t, y: absY };
      })) as { text: string, y: number };
      if (!text) continue;
      const item: GeneralSeenItem = Number.isFinite(y) ? { text, seen: false, y, loc: handle } : { text, seen: false, loc: handle };
      out.push(item);
    }
    return out;
  } catch { return []; }
}

async function fillPhoneAndContinue(page: any, phone: string): Promise<boolean> {
  const input = await page.waitForSelector(SEL.phoneInput, { timeout: 1000 }).catch(() => null);
  if (!input) return false;
  await humanPause(page, 150, 300);
  try { await input.fill(''); } catch {}
  await humanPause(page, 120, 240);
  await input.type(phone, { delay: 60 + Math.floor(Math.random() * 70) });
  await humanPause(page, 150, 250);
  try { await page.keyboard.press('Enter'); } catch {}
  return true;
}

async function enterOtpIfPresent(page: any): Promise<boolean> {
  const otp = await page.waitForSelector(SEL.otpInput, { timeout: 1000 }).catch(() => null);
  if (!otp) return false;
  const code = await waitForCodeFromUrl(VTB_GET_CODE_URL, 180000, /^\d{4,8}$/);
  await humanPause(page, 150, 300);
  try { await otp.fill(''); } catch {}
  await humanPause(page, 120, 240);
  await otp.type(code, { delay: 70 + Math.floor(Math.random() * 60) });
  try { await fetch(VTB_DELETE_CODE_URL, { method: 'DELETE' }); } catch {}
  return true;
}

async function enterPinIfPresent(page: any): Promise<boolean> {
  const pinHandle = await page.waitForSelector(SEL.passcodeInput, { timeout: 1000 }).catch(() => null);
  if (!pinHandle) return false;
  const pin = (process.env.TSUNADE__VTB_PIN ?? '').trim();
  await humanPause(page, 150, 300);
  try { await pinHandle.fill(''); } catch {}
  await humanPause(page, 120, 240);
  if (pin) await pinHandle.type(pin, { delay: 70 + Math.floor(Math.random() * 60) });
  return true;
}

async function clickAndParseItem(page: any, loc: any, returnScrollY?: number): Promise<BankOperationItem | null> {
  // click on item
  try {
    console.log('-------------------------------------------')
    await humanPause(page, 1200, 2000);
    if (typeof returnScrollY === 'number' && Number.isFinite(returnScrollY)) {
      try {
        await page.evaluate((y: number) => { window.scrollTo(0, Math.max(0, y - 80)); }, returnScrollY);
      } catch {}
    }
    try { console.log('[vtb] clickAndParseItem:scrolled'); } catch {}

    await humanPause(page, 200, 800);
    
    await loc.click();
    try { console.log('[vtb] clickAndParseItem:clicked'); } catch {}
  } catch (e) { try { console.log('[vtb] clickAndParseItem:error_click', { e }); } catch {} return null; }
  // wait for details
  try {
    // try { console.log('[vtb] clickAndParseItem:wait_details_header', { index }); } catch {}
    const ok = await page.evaluate((sel: string) => {
      const h = document.querySelector(sel);
      const t = h ? (h.textContent || '').trim() : '';
      return !!h && t.length > 0;
    }, SEL.detailsHeader);
    // try { console.log('[vtb] clickAndParseItem:details_header_ok', { index, ok }); } catch {}
    if (!ok) {
      try { console.log('[vtb] clickAndParseItem:details_header_not_ready'); } catch {}
      return null;
    }
  } catch (e) { try { console.log('[vtb] clickAndParseItem:error_wait_details', { e }); } catch {} return null; }
  // collect details
  try {
    // try { console.log('[vtb] clickAndParseItem:extract_details', { index }); } catch {}
    // try { console.log('[vtb] extract:h1_wait', { index }); } catch {}
    const h1Handle = await page.waitForSelector('main h1', { timeout: 1000 }).catch(() => null);
    const title = h1Handle ? await page.evaluate((el: Element) => (el.textContent || '').trim(), h1Handle) : '';
    try { console.log('[vtb] extract:title', { title }); } catch {}
    const mainEl = await page.waitForSelector('main', { timeout: 1000 }).catch(() => null);
    const textAll = mainEl ? await page.evaluate((el: Element) => (el as any).innerText || '', mainEl) : '';
    // try { console.log('[vtb] extract:textAll_len', { index, len: textAll.length }); } catch {}
    const pEls = await page.$$('main p');
    // try { console.log('[vtb] extract:p_count', { index, count: pEls.length }); } catch {}
    const pTexts: string[] = [];
    for (const p of pEls) {
      const t = await page.evaluate((el: Element) => (el.textContent || '').trim(), p);
      if (t) pTexts.push(t);
    }
    // try { console.log('[vtb] extract:p_texts_len', { index, len: pTexts.length, sample: pTexts.slice(0, 3) }); } catch {}
    let category = '';
    let datetimeText = '';
    let amountText = '';
    for (const t of pTexts) {
      if (!category && t && !t.includes('₽') && /[А-Яа-яA-Za-z]/.test(t) && !/\d{1,2}:\d{2}/.test(t)) category = t;
      if (!datetimeText && /\d{1,2}\s+[А-Яа-я]+.*\d{1,2}:\d{2}/.test(t)) datetimeText = t;
      if (!amountText && t.includes('₽')) amountText = t;
    }
    // try { console.log('[vtb] extract:derived', { index, category, datetimeText, amountText }); } catch {}
    const h2Els = await page.$$('main h2');
    // try { console.log('[vtb] extract:h2_count', { index, count: h2Els.length }); } catch {}
    let detailsIndex = -1;
    for (let i = 0; i < h2Els.length; i++) {
      const t = await page.evaluate((el: Element) => (el.textContent || '').trim().toLowerCase(), h2Els[i]);
      if (t === 'детали операции') { detailsIndex = i; break; }
    }
    // try { console.log('[vtb] extract:details_index', { index, detailsIndex }); } catch {}
    const detailsMap: Record<string, string> = {};
    if (detailsIndex >= 0) {
      const targetH2 = h2Els[detailsIndex];
      const detailTexts: string[] = await page.evaluate((h: Element) => {
        const out: string[] = [];
        let el: Element | null = (h as Element).nextElementSibling as Element | null;
        while (el && el.tagName !== 'H2') {
          const ps = Array.from(el.querySelectorAll('p')) as Element[];
          if (ps.length > 0) {
            for (const p of ps) {
              const t = (p.textContent || '').trim();
              if (t) out.push(t);
            }
          }
          el = el.nextElementSibling as Element | null;
        }
        return out;
      }, targetH2);
      // try { console.log('[vtb] extract:detail_texts_len', { index, len: detailTexts.length, sample: detailTexts.slice(0, 4) }); } catch {}
      for (let i = 0; i < detailTexts.length - 1; i++) {
        const a = String(detailTexts[i] ?? '');
        const b = String(detailTexts[i + 1] ?? '');
        const aNorm = a.trim().toLowerCase();
        if (!aNorm || !b) continue;
        if (aNorm === b.trim().toLowerCase()) continue;
        detailsMap[aNorm] = b;
      }
    }
    // try { console.log('[vtb] extract:details_map', { index, keys: Object.keys(detailsMap) }); } catch {}
    // try { console.log('[vtb] clickAndParseItem:details_raw', { index, title, category, datetimeText, amountText, textAllLen: textAll.length }); } catch {}
    // try { console.log('[vtb] clickAndParseItem:details_map_count', { index, count: Object.keys(detailsMap).length }); } catch {}
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
    let categoryResolved = String(category || '').trim();
    const catM = String(textAll || '').match(/категория\s+([^\n]+)/i);
    // try { console.log('[vtb] clickAndParseItem:category_initial', { index, category: categoryResolved }); } catch {}
    if (catM && catM[1]) categoryResolved = catM[1].trim();
    if (!categoryResolved) {
      const cs = String(category || '');
      const idx = cs.toLowerCase().indexOf('категория');
      if (idx >= 0) {
        const before = cs.slice(0, idx).trim();
        const after = cs.slice(idx + 'категория'.length).trim();
        categoryResolved = after || before || cs.trim();
      }
    }
    // try { console.log('[vtb] clickAndParseItem:category_resolved', { index, category: categoryResolved }); } catch {}
    const dtM = String(textAll || '').match(/\d{1,2}\s+[А-Яа-я]+(?:\s+\d{4}\s*г?\.?){0,1}[,\s]+\d{1,2}:\d{2}/);
    const dtResolved = dtM ? dtM[0].trim() : String(datetimeText || '');
    const m = dtResolved.match(/(\d{1,2})\s+([А-Яа-я]+)/);
    const rawDate = m ? `${m[1]} ${m[2]}` : dtResolved;
    const datetime = parseRuDateTime(dtResolved);
    // try { console.log('[vtb] clickAndParseItem:datetime', { index, dtResolved, rawDate, datetime }); } catch {}
    const item: BankOperationItem = {
      date: datetime ? datetime.toISOString().slice(0, 10) : '',
      text: String(title || ''),
      category: categoryResolved,
      amount: parseAmount(String(amountText || '')),
      opDateTimeText: dtResolved,
      opDateTime: datetime ? datetime.toISOString() : '',
      details: detailsMap,
    };
    // try { console.log('[vtb] clickAndParseItem:amounts', { index, amountText: String(amountText || ''), amount: item.amount, fee: item.feeAmount, total: item.totalAmount }); } catch {}
    // try { console.log('[vtb] clickAndParseItem:item_fields', { index, text: item.text, category: item.category, accountName: item.accountName, counterparty: item.counterparty, channel: item.channel }); } catch {}
    // try { console.log('[vtb] parsed', { t: item.text, cat: item.category, dt: item.opDateTimeText, amt: item.amount }); } catch {}
    return item;
  } catch (e) {
    try { console.log('[vtb] clickAndParseItem:error_parse', { e }); } catch {}
    return null;
  } finally {
    try { console.log('[vtb] clickAndParseItem:go_back'); } catch {}
    await humanPause(page, 1500, 2000);

    try { await page.evaluate(() => history.back()); } catch (e) { try { console.log('[vtb] clickAndParseItem:error_history_back', { e }); } catch {} }

    let backWait = 0;
    let wasReady = false;
    while (backWait < 10000) {
      const onList = await isListReady(page);
      try { console.log('[vtb] clickAndParseItem:waiting_back', { backWait, onList }); } catch {}
      if (onList) { wasReady = true; break; }
      await page.waitForTimeout(200);
      backWait += 200;
    }
    try { console.log('[vtb] clickAndParseItem:back_done', { backWait, wasReady }); } catch {}
  }
}

function parseRuDateTime(text: string): Date | null {
  const s = (text || '').trim().toLowerCase();
  const m = s.match(/(\d{1,2})\s+([а-я]+)\s+(\d{4}).*?(\d{1,2}):(\d{2})/);
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  if (!m) return null;
  const day = Number(m[1] ?? '');
  const monStr = m[2] ?? '';
  const year = Number(m[3] ?? '');
  const hh = Number(m[4] ?? '');
  const mm = Number(m[5] ?? '');
  const mi = months.indexOf(monStr);
  if (!Number.isFinite(day) || !Number.isFinite(year) || mi < 0 || !Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return new Date(year, mi, day, hh, mm);
}

function extendGeneralSeen(generalSeenArray: GeneralSeenItem[], lastSnapshot: GeneralSeenItem[]): GeneralSeenItem[] {
  const tempGeneralSeen = generalSeenArray.map(item => ({ ...item, checked: false }));
  const newGeneralSeen: GeneralSeenItem[] = [];
  const newItemsTexts: string[] = [...lastSnapshot.map(s => s.text)];
  const newItemsYs: number[] = [...lastSnapshot.map(s => (typeof s.y === 'number' ? s.y : NaN))];
  const newItemsLocs: any[] = [...lastSnapshot.map(s => s.loc)];

  for (let i = 0; i < lastSnapshot.length; i++) {
    const text = lastSnapshot[i]!.text;
    const uncheckedIndex = tempGeneralSeen.findIndex(item => item.text === text && !item.checked);
    if (uncheckedIndex >= 0) {
      tempGeneralSeen[uncheckedIndex]!.checked = true;
      const existedTextIndex = newItemsTexts.indexOf(text);
      if (existedTextIndex >= 0) {
        newItemsTexts.splice(existedTextIndex, 1);
        newItemsYs.splice(existedTextIndex, 1);
      }
    }
  }

  newItemsTexts.forEach((text, idx) => {
    const y = newItemsYs[idx];
    const loc = newItemsLocs[idx];
    const item: GeneralSeenItem = Number.isFinite(y) ? { text, seen: false, y: y as number, loc } : { text, seen: false, loc };
    newGeneralSeen.push(item);
  });

  console.log('[vtb] extendGeneralSeen', { newItemsTexts });

  return newGeneralSeen;
}

function getNextIndexToCollect(generalSeen: GeneralSeenItem[], lastSnapshot: GeneralSeenItem[]): number {
  for (let i = 0; i < generalSeen.length; i++) {
    const gs = generalSeen[i]!;
    if (gs.seen) continue;
    const j = lastSnapshot.findIndex(s => s.text === gs.text);
    if (j >= 0) {
      console.log('~ ~')
      console.log(generalSeen.map(s => ({ text: s.text.slice(0, 15), y: s.y, seen: s.seen })))
      console.log('~ ~')
      console.log(lastSnapshot.map(s => ({ text: s.text.slice(0, 15), y: s.y })))
      console.log('~ ~')
      console.log('[vtb] getNextIndexToCollect', { i, text: gs.text });
      return i;
    }
  }
  return -1;
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickKeyPartsForMatch(full: string): string[] {
  const norm = full.replace(/\s+/g, ' ').trim();
  // Heuristics: prefer counterparty and amount strings, which are typically distinct
  const lines = norm.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const ln of lines) {
    if (/₽|руб/i.test(ln)) { parts.push(ln); break; }
  }
  if (lines.length > 0) parts.unshift(lines[0]!);
  return Array.from(new Set(parts)).slice(0, 2);
}

function findIndexByY(snapshot: GeneralSeenItem[], y: number): number {
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < snapshot.length; i++) {
    const s = snapshot[i]!;
    const sy = typeof s.y === 'number' ? (s.y as number) : NaN;
    if (!Number.isFinite(sy)) continue;
    const d = Math.abs(sy - y);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}
