import 'dotenv/config';
import { sendText } from './telegram.js';
import { VtbCollector } from './banks/vtb.js';
import type { BankOperationItem } from './banks/types.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

type DbOp = {
  raw_date: string;
  op_date: string;
  text: string;
  bank_category: string;
  amount: number;
  bank: string;
  op_datetime_text?: string | null;
  op_datetime?: Date | null;
  details?: Record<string, string> | null;
  rrn?: string | null;
  id_hash?: string | null;
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

async function getLatestKnown(POOL: PgPool, bank: string): Promise<{ raw_date: string; text: string; amount: number; op_datetime_text: string | null } | null> {
  const sql = 'select raw_date, text, amount, op_datetime_text from finance.operations where bank = $1 order by id desc limit 1';
  const r = await POOL.query(sql, [bank]);
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

async function getRecentRrns(POOL: PgPool, bank: string, limit: number = 10): Promise<Set<string>> {
  const sql = 'select rrn from finance.operations where bank = $1 and rrn is not null order by id desc limit $2';
  const r = await POOL.query(sql, [bank, limit]);
  const s = new Set<string>();
  for (const row of r.rows) {
    const v = String(row.rrn || '').trim();
    if (v) s.add(v);
  }
  return s;
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
  const cols = ['raw_date','op_date','text','bank_category','amount','bank','op_datetime_text','op_datetime','details','rrn','id_hash'];
  const valuesSql = ops.map((_, i) => '(' + cols.map((__, j) => `$${i*cols.length + j + 1}`).join(', ') + ')').join(', ');
  const sql = `insert into finance.operations (${cols.join(', ')}) values ${valuesSql}
    on conflict do nothing`;
  const params: any[] = [];
  for (const o of ops) {
    params.push(
      o.raw_date,
      o.op_date,
      o.text,
      o.bank_category,
      o.amount,
      o.bank,
      o.op_datetime_text ?? null,
      o.op_datetime ?? null,
      o.details ? JSON.stringify(o.details) : null,
      o.rrn ?? null,
      o.id_hash ?? null,
    );
  }
  const r = await POOL.query(sql, params);
  return r.rowCount || ops.length;
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

async function main(): Promise<void> {
  const pool = await makePool();
  // await sendText('Скоро будет SMS код');
  const collector = new VtbCollector();
  try {
    await collector.init({ headless: false });
    await collector.loginAndPrepare();

    let latest = await getLatestKnown(pool, 'vtb');
    const recentRrns = await getRecentRrns(pool, 'vtb', 10);
    let collected: BankOperationItem[] = [];
    const sentinel = '__STOP_ON_OLD__';
    const onSnapshot = async (items: BankOperationItem[]) => {
      console.log(`[vtb] onSnapshot ${items.length} operations`);
      collected.push(...items);
      if (recentRrns.size > 0) {
        const hasRecentRrn = items.some(it => {
          const d = it.details || {};
          const key = Object.keys(d).find(k => k.toLowerCase() === 'rrn');
          const v = key ? (d as Record<string, string>)[key] : undefined;
          const s = (v || '').trim();
          return !!s && recentRrns.has(s);
        });
        if (hasRecentRrn) throw new Error(sentinel);
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
    // console.log(items);

    const newestFirst = items;
    console.log(`[vtb] newest first ${newestFirst.length} operations`);
    // console.log(newestFirst);

    const newOnly: DbOp[] = [];
    for (const it of newestFirst) {
      const rrnIt = (() => {
        const d = it.details || {};
        const key = Object.keys(d).find(k => k.toLowerCase() === 'rrn');
        const v = key ? (d as Record<string, string>)[key] : undefined;
        const s = (v || '').trim();
        return s || '';
      })();
      const isOldByRrn = rrnIt ? recentRrns.has(rrnIt) : false;
      const isOldByLegacy = latest && (it.date === latest.raw_date && it.text === latest.text && it.amount === Number(latest.amount) && (it.opDateTimeText || '') === (latest.op_datetime_text || ''));
      const isOld = isOldByRrn || !!isOldByLegacy;
      if (isOld) break;
      // compute deterministic id_hash from a stable set of fields
      const detailPairs = Object.entries(it.details || {}).filter(([k, v]) => !!k && !!v);
      detailPairs.sort(([a], [b]) => a.localeCompare(b));
      const identitySource = JSON.stringify({
        text: it.text,
        amount: it.amount,
        opDateTimeText: it.opDateTimeText || '',
        details: detailPairs,
      });
      const idHash = crypto.createHash('sha256').update(identitySource).digest('hex').slice(0, 24);
      const rrn = (() => {
        const d = it.details || {};
        const key = Object.keys(d).find(k => k.toLowerCase() === 'rrn');
        const v = key ? (d as Record<string, string>)[key] : undefined;
        const s = (v || '').trim();
        return s ? s : null;
      })();

      newOnly.push({
        raw_date: it.date,
        op_date: normalizeDate(it.date),
        text: it.text,
        bank_category: it.category,
        amount: it.amount,
        bank: 'vtb',
        op_datetime_text: it.opDateTimeText || null,
        op_datetime: parseRuDateTime(it.opDateTimeText || '') || null,
        details: it.details || null,
        rrn,
        id_hash: idHash,
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
