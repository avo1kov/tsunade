import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from './mcp-common.js';

async function main(): Promise<void> {
  const app = express();
  app.use(express.json());

  const bearer = (process.env.TSUNADE__MCP_BEARER || process.env.MCP_BEARER || '').trim();
  const requireAuth = bearer.length > 0;

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post('/mcp', async (req: express.Request, res: express.Response) => {
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
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
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

  app.get('/mcp', async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send('invalid session');
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (transport) {
      transport.close();
      delete transports[sessionId as string];
    }
    res.status(204).end();
  });

  const port = Number((process.env.TSUNADE__MCP_PORT || 3000));
  app.listen(port);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
