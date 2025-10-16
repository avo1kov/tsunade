import 'dotenv/config';
import { sendText } from './telegram.js';
import { VtbCollector } from './banks/vtb.js';
import type { BankOperationItem } from './banks/types.js';
import fs from 'node:fs/promises';

type DbOp = {
  raw_date: string;
  op_date: string;
  text: string;
  bank_category: string;
  amount: number;
  bank: string;
};

type PgPool = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;
  end: () => Promise<void>;
};

async function makePool(): Promise<PgPool> {
  const envVal = process.env.TSUNADE__PG_CONN_INFO;
  const conn = (envVal ?? '').trim();
  if (!conn) throw new Error('missing TSUNADE__PG_CONN_INFO');
  const mod: any = await import('pg');
  const PoolCtor = mod.Pool || mod.default?.Pool || mod;
  const pool = new PoolCtor({ connectionString: conn });
  return pool as PgPool;
}

async function getLatestKnown(POOL: PgPool, bank: string): Promise<{ raw_date: string; text: string; amount: number } | null> {
  const sql = 'select raw_date, text, amount from finance.operations where bank = $1 order by id desc limit 1';
  const r = await POOL.query(sql, [bank]);
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

function normalizeDate(raw: string): string {
  const s = raw.trim().toLowerCase();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (s.includes('сегодня')) return today.toISOString().slice(0, 10);
  if (s.includes('вчера')) return new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const m = s.match(/(\d{1,2})\s+([а-я]+)/);
  if (m) {
    const dayStr = m[1] ?? '';
    const monStr = m[2] ?? '';
    const d = Number(dayStr);
    const mi = months.indexOf(monStr);
    const year = now.getFullYear();
    if (Number.isFinite(d) && d > 0 && mi >= 0) {
      const dt = new Date(year, mi, d);
      return dt.toISOString().slice(0, 10);
    }
  }
  return today.toISOString().slice(0, 10);
}

async function insertNew(POOL: PgPool, ops: DbOp[]): Promise<number> {
  if (ops.length === 0) return 0;
  const sql = 'insert into finance.operations (raw_date, op_date, text, bank_category, amount, bank) values ' +
    ops.map((_, i) => `($${i*6+1}, $${i*6+2}, $${i*6+3}, $${i*6+4}, $${i*6+5}, $${i*6+6})`).join(', ');
  const params: any[] = [];
  for (const o of ops) {
    params.push(o.raw_date, o.op_date, o.text, o.bank_category, o.amount, o.bank);
  }
  const r = await POOL.query(sql, params);
  return r.rowCount || ops.length;
}

async function main(): Promise<void> {
  const pool = await makePool();
  // await sendText('Скоро будет SMS код');
  const collector = new VtbCollector();
  try {
    await collector.init({ headless: false });
    await collector.loginAndPrepare();

    let latest = await getLatestKnown(pool, 'vtb');
    let collected: BankOperationItem[] = [];
    const sentinel = '__STOP_ON_OLD__';
    const onSnapshot = async (items: BankOperationItem[]) => {
      console.log(`[vtb] onSnapshot ${items.length} operations`);
      collected.push(...items);
      if (latest) {
        const found = items.some(it => it.date === latest!.raw_date && it.text === latest!.text && it.amount === Number(latest!.amount));
        if (found) throw new Error(sentinel);
      }
    };
    try {
      await collector.collectOperations(200, onSnapshot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== sentinel) throw e;
    }
    const items = collected;

    console.log(`[vtb] collected ${items.length} operations`);
    console.log(items);

    const newestFirst = items;
    console.log(`[vtb] newest first ${newestFirst.length} operations`);
    console.log(newestFirst);

    const newOnly: DbOp[] = [];
    for (const it of newestFirst) {
      const isOld = latest && it.date === latest.raw_date && it.text === latest.text && it.amount === Number(latest.amount);
      if (isOld) break;
      newOnly.push({
        raw_date: it.date,
        op_date: normalizeDate(it.date),
        text: it.text,
        bank_category: it.category,
        amount: it.amount,
        bank: 'vtb'
      });
    }
    if (newOnly.length > 0) {
      await insertNew(pool, newOnly.reverse());
    }
    await fs.mkdir('./dist', { recursive: true });
    await fs.writeFile('./dist/operations-first.json', JSON.stringify(items, null, 2), 'utf8');
  } finally {
    await collector.shutdown();
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
