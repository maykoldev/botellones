// Simple backend HTTP server without external dependencies
// - Serves the SPA (botellones.html) from the project root
// - Exposes REST APIs for admins, clients, transactions
// - Persists data into data/db.json (created on first run)
// Run: node server/server.js

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// Default seed data
const DEFAULT_DB = {
  admins: [
    { username: 'admin', password: 'admin123', name: 'Administrador Principal' }
  ],
  clients: [
    { id: '12345678', name: 'Juan Pérez', phone: '0412-1234567', address: '' },
    { id: '87654321', name: 'María García', phone: '0414-7654321', address: '' }
  ],
  transactions: []
};

async function ensureDb() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.access(DB_PATH, fs.constants.F_OK).catch(async () => {
      await saveDb(DEFAULT_DB);
    });
  } catch (e) {
    console.error('DB init error:', e);
  }
}

async function readDb() {
  const raw = await fsp.readFile(DB_PATH, 'utf8');
  return JSON.parse(raw || '{}');
}

async function saveDb(db) {
  const tmp = DB_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, DB_PATH);
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e7) {
        // ~10MB limit
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  // Serve index: prefer public/index.html if exists; otherwise botellones.html in root
  const publicIndex = path.join(ROOT, 'public', 'index.html');
  const rootHtml = path.join(ROOT, 'botellones.html');

  // Static file resolver for /public and /img
  let pathname = url.parse(req.url).pathname || '/';
  if (pathname === '/') {
    // index
    return fs.promises
      .access(publicIndex)
      .then(() => fs.promises.readFile(publicIndex))
      .then(buf => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buf);
      })
      .catch(async () => {
        // fallback to botellones.html in root
        try {
          const html = await fs.promises.readFile(rootHtml);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (e) {
          notFound(res);
        }
      });
  }

  // Serve from public folder if exists (strip leading '/' and prevent path traversal)
  const safePublicRoot = path.join(ROOT, 'public');
  const relPath = (pathname || '/').replace(/^\/+/, '');
  const publicPath = path.join(safePublicRoot, relPath);

  if (!publicPath.startsWith(safePublicRoot)) {
    return notFound(res);
  }
  fs.promises
    .stat(publicPath)
    .then(stat => {
      if (stat.isFile()) {
        const ext = path.extname(publicPath).toLowerCase();
        const type =
          ext === '.html' ? 'text/html; charset=utf-8' :
          ext === '.css' ? 'text/css; charset=utf-8' :
          ext === '.js' ? 'application/javascript; charset=utf-8' :
          ext === '.png' ? 'image/png' :
          ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
          ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        fs.createReadStream(publicPath).pipe(res);
      } else {
        notFound(res);
      }
    })
    .catch(() => notFound(res));
}

// API Handlers
async function handleAuth(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/auth/admin') {
    try {
      const body = await parseBody(req);
      const { username, password } = body || {};
      const db = await readDb();
      const admin = (db.admins || []).find(a => a.username === username && a.password === password);
      if (!admin) return sendJSON(res, 401, { error: 'Credenciales inválidas' });
      // For simplicity: return admin without password
      const { password: _, ...adminSafe } = admin;
      return sendJSON(res, 200, { user: adminSafe, role: 'admin' });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/client') {
    try {
      const body = await parseBody(req);
      const { id } = body || {};
      const db = await readDb();
      const client = (db.clients || []).find(c => c.id === id);
      if (!client) return sendJSON(res, 404, { error: 'Cliente no encontrado' });
      return sendJSON(res, 200, { user: client, role: 'client' });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  return false;
}

async function handleClients(req, res, pathname) {
  if (pathname === '/api/clients' && req.method === 'GET') {
    const db = await readDb();
    return sendJSON(res, 200, db.clients || []);
  }
  if (pathname === '/api/clients' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { id, name, phone, address } = body || {};
      if (!id || !name) return sendJSON(res, 400, { error: 'Cédula y nombre son obligatorios' });
      const db = await readDb();
      const clients = db.clients || [];
      const idx = clients.findIndex(c => c.id === id);
      if (idx !== -1) clients[idx] = { id, name, phone, address };
      else clients.push({ id, name, phone, address });
      db.clients = clients;
      await saveDb(db);
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }
  if (pathname.startsWith('/api/clients/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.split('/').pop());
    const db = await readDb();
    db.clients = (db.clients || []).filter(c => c.id !== id);
    await saveDb(db);
    return sendJSON(res, 200, { ok: true });
  }
  return false;
}

async function handleTransactions(req, res, pathname, parsedUrl) {
  if (pathname === '/api/transactions' && req.method === 'GET') {
    const db = await readDb();
    const q = parsedUrl.query || {};
    const clientId = q.clientId;
    let arr = db.transactions || [];
    if (clientId) arr = arr.filter(t => t.clientId === clientId);
    // decorate with client name
    const clientsMap = new Map((db.clients || []).map(c => [c.id, c]));
    const out = arr.map(t => ({
      ...t,
      clientName: clientsMap.get(t.clientId)?.name || 'Cliente desconocido'
    }));
    return sendJSON(res, 200, out);
  }

  if (pathname === '/api/transactions' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { clientId, bottles, delivered = 0, currency, amount, paid } = body || {};
      if (!clientId || !bottles || !currency) return sendJSON(res, 400, { error: 'Datos incompletos' });
      const db = await readDb();
      const trx = {
        id: Date.now().toString(),
        clientId,
        bottles: Number(bottles) || 0,
        delivered: Number(delivered) || 0,
        currency,
        amount: Number(amount) || 0,
        paid: !!paid,
        date: new Date().toISOString(),
        locked: (Number(delivered) || 0) >= (Number(bottles) || 0)
      };
      db.transactions = db.transactions || [];
      db.transactions.push(trx);
      await saveDb(db);
      return sendJSON(res, 200, trx);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (pathname.startsWith('/api/transactions/') && req.method === 'PUT') {
    try {
      const id = decodeURIComponent(pathname.split('/').pop());
      const body = await parseBody(req);
      const db = await readDb();
      const arr = db.transactions || [];
      const idx = arr.findIndex(t => t.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Transacción no encontrada' });
      const current = arr[idx];
      if (current.locked) return sendJSON(res, 400, { error: 'Transacción cerrada. No editable' });
      const next = {
        ...current,
        delivered: body.delivered != null ? Number(body.delivered) : current.delivered,
        currency: body.currency || current.currency,
        amount: body.amount != null ? Number(body.amount) : current.amount,
        paid: body.paid != null ? !!body.paid : current.paid
      };
      if (next.delivered >= next.bottles) next.locked = true;
      arr[idx] = next;
      db.transactions = arr;
      await saveDb(db);
      return sendJSON(res, 200, next);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (pathname.startsWith('/api/transactions/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.split('/').pop());
    const db = await readDb();
    const arr = db.transactions || [];
    const t = arr.find(x => x.id === id);
    if (!t) return sendJSON(res, 404, { error: 'Transacción no encontrada' });
    if (t.locked || (t.delivered || 0) >= (t.bottles || 0)) {
      return sendJSON(res, 400, { error: 'No se puede eliminar una transacción cerrada' });
    }
    db.transactions = arr.filter(x => x.id !== id);
    await saveDb(db);
    return sendJSON(res, 200, { ok: true });
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  // Basic CORS (allow same-origin and simple cross-origin for testing)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '/';

  // API routes
  if (pathname.startsWith('/api/')) {
    try {
      if (await handleAuth(req, res, pathname) !== false) return;
      if (await handleClients(req, res, pathname) !== false) return;
      if (await handleTransactions(req, res, pathname, parsedUrl) !== false) return;
      return notFound(res);
    } catch (e) {
      return sendJSON(res, 500, { error: 'Server error', detail: e.message });
    }
  }

  // Static assets and SPA
  return serveStatic(req, res);
});

ensureDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Serving SPA at / (uses public/index.html if present, else botellones.html)');
  });
});
