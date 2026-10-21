import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import cors from 'cors';
import pg from 'pg';
import { Server } from 'socket.io';
import { z } from 'zod';
import { registerSockets } from './socket/register.js';
import { createApiRouter } from './routes/api.js';
const { Pool } = pg;
const app = express();
const server = http.createServer(app);
const origins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());
app.use(cors({ origin: origins, credentials: false }));
app.use(express.json({ limit: '32kb' }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'ipl-auction-api' }); }
  catch { res.status(503).json({ ok: false, error: 'database_unavailable' }); }
});
app.use('/api', createApiRouter(pool));
const io = new Server(server, { cors: { origin: origins } });
registerSockets(io, pool);
const port = Number(process.env.PORT || 4000);
server.listen(port, () => console.log(`IPL auction API listening on ${port}`));
