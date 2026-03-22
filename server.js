'use strict';
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ── File-based game storage ───────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Results storage ───────────────────────────────────────────────────────────
const RESULTS_DIR = process.env.RESULTS_DIR || path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

function saveResult(result) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(RESULTS_DIR, `${ts}_${result.code || 'solo'}.json`);
  fs.writeFileSync(file, JSON.stringify(result));
}

function listResults(limit = 30) {
  try {
    return fs.readdirSync(RESULTS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort().reverse()
      .slice(0, limit)
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

function gamePath(code) { return path.join(DATA_DIR, `${code}.json`); }
function gameExists(code) { return fs.existsSync(gamePath(code)); }
function readGame(code) {
  try { return JSON.parse(fs.readFileSync(gamePath(code), 'utf8')); } catch { return null; }
}
function writeGame(code, state) {
  fs.writeFileSync(gamePath(code), JSON.stringify(state));
}

// Prune game files older than 48 hours
function pruneGames() {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith('.json')) continue;
      const stat = fs.statSync(path.join(DATA_DIR, f));
      if (stat.mtimeMs < cutoff) fs.unlinkSync(path.join(DATA_DIR, f));
    }
  } catch { /* ignore */ }
}
setInterval(pruneGames, 3_600_000);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Room code generator ───────────────────────────────────────────────────────
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
function genCode() {
  for (let i = 0; i < 100; i++) {
    const code = Array.from({ length: 4 }, () => CHARS[Math.random() * CHARS.length | 0]).join('');
    if (!gameExists(code)) return code;
  }
  throw new Error('Could not generate unique room code');
}

// ── REST routes ───────────────────────────────────────────────────────────────
app.post('/api/games', (req, res) => {
  try {
    const code = genCode();
    writeGame(code, req.body.state ?? {});
    res.json({ code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/games/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const state = readGame(code);
  if (!state) return res.status(404).json({ error: 'Room not found' });
  res.json(state);
});

// ── Results routes ────────────────────────────────────────────────────────────
app.post('/api/results', (req, res) => {
  try {
    const result = req.body;
    if (!result.players || !result.totals) return res.status(400).json({ error: 'Invalid result' });
    result.savedAt = new Date().toISOString();
    saveResult(result);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/results', (req, res) => {
  res.json(listResults(parseInt(req.query.limit) || 30));
});

// ── Card scanning ─────────────────────────────────────────────────────────────
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

  const state = readGame(code);
  if (!state) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    return ws.close();
  }

  if (!rooms.has(code)) rooms.set(code, new Set());
  rooms.get(code).add(ws);

  ws.send(JSON.stringify({ type: 'state', state }));

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'state' && msg.state) {
        writeGame(code, msg.state);
        broadcast(code, msg, ws);
      }
    } catch { /* ignore malformed */ }
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
