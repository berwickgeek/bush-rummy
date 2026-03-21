'use strict';
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './games.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    code    TEXT PRIMARY KEY,
    state   TEXT NOT NULL,
    updated INTEGER DEFAULT (strftime('%s','now'))
  )
`);

// Prune games older than 48 hours, hourly
setInterval(() => {
  db.prepare("DELETE FROM games WHERE updated < strftime('%s','now') - 172800").run();
}, 3_600_000);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Room code generator ───────────────────────────────────────────────────────
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
function genCode() {
  for (let i = 0; i < 100; i++) {
    const code = Array.from({ length: 4 }, () => CHARS[Math.random() * CHARS.length | 0]).join('');
    if (!db.prepare('SELECT 1 FROM games WHERE code=?').get(code)) return code;
  }
  throw new Error('Could not generate unique room code');
}

// ── REST routes ───────────────────────────────────────────────────────────────
app.post('/api/games', (req, res) => {
  try {
    const code = genCode();
    db.prepare('INSERT INTO games (code,state) VALUES (?,?)').run(code, JSON.stringify(req.body.state ?? {}));
    res.json({ code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/games/:code', (req, res) => {
  const row = db.prepare('SELECT state FROM games WHERE code=?').get(req.params.code.toUpperCase());
  if (!row) return res.status(404).json({ error: 'Room not found' });
  res.json(JSON.parse(row.state));
});

// ── Card scanning (Claude vision) ─────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15_000_000 } });

app.post('/api/scan', upload.single('image'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Card scanning not configured' });
  }
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const round = Math.max(0, Math.min(12, parseInt(req.body.round ?? 0)));
    const wildRanks = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
    const wildRank = wildRanks[round];
    const b64 = req.file.buffer.toString('base64');
    const mime = req.file.mimetype;

    const msg = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
          {
            type: 'text',
            text: `Identify all playing cards clearly visible in this photo. Calculate the Bush Rummy hand score.

Scoring rules:
- Jokers: 0 points
- 2s: 15 points
- 3 through 10: face value (3=3, 4=4, ..., 10=10)
- Jacks: 11 points
- Queens: 12 points
- Kings: 13 points
- Aces: 14 points
- Wild card this round is ${wildRank}s — they still score their face value

Reply ONLY with valid JSON, no markdown, no extra text:
{"cards":["Ah","Kd","Jc"],"score":38,"breakdown":"A♥ 14 + K♦ 13 + J♣ 11"}`
          }
        ]
      }]
    });

    const text = msg.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Claude response');
    res.json(JSON.parse(match[0]));
  } catch (e) {
    console.error('scan error:', e.message);
    res.status(500).json({ error: 'Could not read cards', detail: e.message });
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const rooms = new Map(); // code → Set<WebSocket>

function persist(code, state) {
  db.prepare("UPDATE games SET state=?, updated=strftime('%s','now') WHERE code=?")
    .run(JSON.stringify(state), code);
}

function broadcast(code, msg, except = null) {
  const clients = rooms.get(code);
  if (!clients) return;
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws !== except && ws.readyState === 1) ws.send(s);
  }
}

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const code = params.get('code')?.toUpperCase();
  if (!code) return ws.close(1008, 'Missing room code');

  const row = db.prepare('SELECT state FROM games WHERE code=?').get(code);
  if (!row) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    return ws.close();
  }

  if (!rooms.has(code)) rooms.set(code, new Set());
  rooms.get(code).add(ws);

  // Send current state to newcomer
  ws.send(JSON.stringify({ type: 'state', state: JSON.parse(row.state) }));

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'state' && msg.state) {
        persist(code, msg.state);
        broadcast(code, msg, ws);
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    rooms.get(code)?.delete(ws);
    if (!rooms.get(code)?.size) rooms.delete(code);
  });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Bush Rummy listening on port ${PORT}`));
