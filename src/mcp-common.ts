import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

type PgPool = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;
  end: () => Promise<void>;
};

async function makePool(): Promise<PgPool> {
  const envVal = process.env.TSUNADE__PG_CONN_INFO;
  const conn = (envVal ?? '').trim();
  if (!conn) throw new Error('missing TSUNADE__PG_CONN_INFO');
  const mod: any = await import('pg');
  const PoolCtor = (mod as any).Pool || (mod as any).default?.Pool || mod;
  const pool = new PoolCtor({ connectionString: conn });
  return pool as PgPool;
}

export const GetOperationsArgs = z.object({
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
  date_range: z
    .object({ from: z.string().min(1).optional(), to: z.string().min(1).optional() })
    .optional(),
  amount_range: z
    .object({ min: z.number().optional(), max: z.number().optional() })
    .optional(),
  text_ilike: z.string().trim().min(1).optional(),
  bank_category_ilike: z.string().trim().min(1).optional(),
});

const GetOpsSumAllArgs = z.object({
  granularity: z.enum(['day', 'week', 'month', 'year']).default('day'),
  date_range: z
    .object({ from: z.string().min(1).optional(), to: z.string().min(1).optional() })
    .optional(),
  limit: z.number().int().min(1).max(1000).default(200),
  offset: z.number().int().min(0).default(0),
});

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'tsunade-mcp', version: '0.1.0' });
  server.registerTool(
    'get_operations',
    {
      title: 'get operations',
      description:
        'Read rows from finance.operations (read-only). Returns newest first across all banks. Supports filters: date_range, amount_range, text_ilike, bank_category_ilike',
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
        date_range: z
          .object({ from: z.string().min(1).optional(), to: z.string().min(1).optional() })
          .optional(),
        amount_range: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
        text_ilike: z.string().trim().min(1).optional(),
        bank_category_ilike: z.string().trim().min(1).optional(),
      },
    },
    async (args) => {
      const input = GetOperationsArgs.parse(args ?? {});
      const pool = await makePool();
      try {
        const params: any[] = [];
        const whereParts: string[] = [];

        if (input.date_range?.from) {
          params.push(input.date_range.from);
          whereParts.push(`coalesce(op_datetime, op_date::timestamptz) >= $${params.length}`);
        }
        if (input.date_range?.to) {
          params.push(input.date_range.to);
          whereParts.push(`coalesce(op_datetime, op_date::timestamptz) <= $${params.length}`);
        }

        if (typeof input.amount_range?.min === 'number') {
          params.push(input.amount_range.min);
          whereParts.push(`amount >= $${params.length}`);
        }
        if (typeof input.amount_range?.max === 'number') {
          params.push(input.amount_range.max);
          whereParts.push(`amount <= $${params.length}`);
        }

        if (input.text_ilike) {
          params.push(`%${input.text_ilike}%`);
          whereParts.push(`"text" ilike $${params.length}`);
        }

        if (input.bank_category_ilike) {
          params.push(`%${input.bank_category_ilike}%`);
          whereParts.push(`bank_category ilike $${params.length}`);
        }

        const where = whereParts.length > 0 ? ` where ${whereParts.join(' and ')}` : '';

        params.push(input.limit);
        const limitParam = params.length;
        params.push(input.offset);
        const offsetParam = params.length;

        const sql = `select id, raw_date, op_date, op_datetime, "text", bank_category, special_category, bank, amount, currency_code, rrn, details, created_at from finance.operations${where} order by coalesce(op_datetime, op_date::timestamptz) desc, id desc limit $${limitParam} offset $${offsetParam}`;
        const r = await pool.query(sql, params);
        return { content: [{ type: 'text', text: JSON.stringify({ rows: r.rows, count: r.rowCount ?? r.rows.length }) }] } as any;
      } finally {
        await pool.end();
      }
    }
  );

  server.registerTool(
    'get_ops_sum_all',
    {
      title: 'get ops summary (materialized view)',
      description:
        'Summarized operations by period from finance.ops_sum_all (materialized view). Filter by granularity and date_range. Returns newest periods first.',
      inputSchema: {
        granularity: z.enum(['day', 'week', 'month', 'year']).default('day'),
        date_range: z
          .object({ from: z.string().min(1).optional(), to: z.string().min(1).optional() })
          .optional(),
        limit: z.number().int().min(1).max(1000).default(200),
        offset: z.number().int().min(0).default(0),
      },
    },
    async (args) => {
      const input = GetOpsSumAllArgs.parse(args ?? {});
      const pool = await makePool();
      try {
        const params: any[] = [];
        const whereParts: string[] = [];

        params.push(input.granularity);
        whereParts.push(`granularity = $${params.length}`);

        if (input.date_range?.from) {
          params.push(input.date_range.from);
          whereParts.push(`period_start >= $${params.length}`);
        }
        if (input.date_range?.to) {
          params.push(input.date_range.to);
          whereParts.push(`period_start <= $${params.length}`);
        }

        const where = whereParts.length > 0 ? ` where ${whereParts.join(' and ')}` : '';

        params.push(input.limit);
        const limitParam = params.length;
        params.push(input.offset);
        const offsetParam = params.length;

        const sql = `select granularity, period_start, tx_count, net_total, income_count, income_total, expense_count, expense_total from finance.ops_sum_all${where} order by period_start desc limit $${limitParam} offset $${offsetParam}`;
        const r = await pool.query(sql, params);
        return { content: [{ type: 'text', text: JSON.stringify({ rows: r.rows, count: r.rowCount ?? r.rows.length }) }] } as any;
      } finally {
        await pool.end();
      }
    }
  );
  return server;
}


