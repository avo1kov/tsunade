import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

const GetOperationsArgs = z.object({
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
  bank: z.string().trim().min(1).optional(),
});

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'tsunade-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'get_operations',
    {
      title: 'get operations',
      description: 'read rows from finance.operations (read-only). optional filter by bank. returns newest first',
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
        bank: z.string().trim().min(1).optional(),
      },
    },
    async (args) => {
      const input = GetOperationsArgs.parse(args ?? {});
      const pool = await makePool();
      try {
        const params: any[] = [];
        let where = '';
        if (input.bank) {
          params.push(input.bank);
          where = ' where bank = $1 ';
        }
        params.push(input.limit);
        const limitParam = params.length;
        params.push(input.offset);
        const offsetParam = params.length;
        const sql = `select id, raw_date, op_date, text, bank_category, my_category, special_category, message, bank, amount, currency_code, created_at from finance.operations${where} order by id desc limit $${limitParam} offset $${offsetParam}`;
        const r = await pool.query(sql, params);
        return {
          content: [{ 
            type: 'text',
            text: JSON.stringify({ rows: r.rows, count: r.rowCount ?? r.rows.length }, null, 2),
          }],
        };
      } finally {
        await pool.end();
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
