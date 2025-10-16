import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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

function buildServer(): McpServer {
  const server = new McpServer({ name: 'tsunade-mcp', version: '0.1.0' });
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
        return { content: [{ type: 'json', json: { rows: r.rows, count: r.rowCount ?? r.rows.length } }] } as any;
      } finally {
        await pool.end();
      }
    }
  );
  return server;
}

async function main(): Promise<void> {
  const app = express();
  app.use(express.json());

  const bearer = (process.env.TSUNADE__MCP_BEARER || process.env.MCP_BEARER || '').trim();
  const requireAuth = bearer.length > 0;

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post('/mcp', async (req, res) => {
    // if (requireAuth) {
    //   const auth = String(req.headers.authorization || '');
    //   const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    //   if (token !== bearer) {
    //     res.status(401).json({ error: 'unauthorized' });
    //     return;
    //   }
    // }

    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports[sessionId] : undefined;
      if (!transport) {
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({ error: 'bad request' });
          return;
        }
        transport = new StreamableHTTPServerTransport({});
        const server = buildServer();
        await server.connect(transport);
        if (transport.sessionId) transports[transport.sessionId] = transport;
        transport.onclose = () => {
          if (transport && transport.sessionId) delete transports[transport.sessionId];
        };
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send('invalid session');
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (transport) {
      transport.close();
      delete transports[sessionId as string];
    }
    res.status(204).end();
  });

  const port = Number((process.env.TSUNADE__PORT || 3000));
  app.listen(port);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
