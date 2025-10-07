
/**
 * Virtual Stock Festival - single server (Express + Socket.IO)
 * Features:
 * - Real-time single/multi-stock trading with automatic price changes
 * - Volatility coefficient controls both price impact and tick frequency
 * - Simple admin console (admin.html) protected by a passcode
 * - In-memory state + JSON persistence (state.json)
 * - Mobile-friendly client UI (index.html)
 *
 * Quick start:
 *   1) npm install
 *   2) (optional) set environment variables:
 *        ADMIN_KEY=yourSecretKey
 *        PORT=3000
 *   3) npm start
 *   4) On the same Wi‑Fi, visit: http://<your-ip>:3000
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const ADMIN_KEY = process.env.ADMIN_KEY || 'festival2025'; // CHANGE THIS!
const PORT = process.env.PORT || 3000;

// ---- Server + Static ----
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// ---- Persistence helpers ----
const STATE_FILE = path.join(__dirname, 'state.json');
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
function saveStateDebounced() {
  if (saveStateDebounced._t) clearTimeout(saveStateDebounced._t);
  saveStateDebounced._t = setTimeout(() => {
    const toSave = { ...state };
    // only save pure data
    delete toSave.runtime;
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2));
  }, 300);
}

// ---- Default state ----
const defaultState = {
  config: {
    startingBalance: 0,
    baseTickMs: 2000,   // lower -> more frequent updates
    liquidity: 800      // higher -> less price impact from a single trade
  },
  stocks: {
    FEST: { name: 'Festival', price: 100, basePrice: 100, volatility: 1.0, paused: false }
  },
  users: {
    // nickname: { balance, holdings: {TICKER: qty}, history: [] }
  }
};

// ---- Load state ----
let state = loadState() || defaultState;
state.runtime = { timers: {} };

// ---- Utils ----
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function round2(n) { return Math.round(n * 100) / 100; }

function ensureUser(nick) {
  const clean = String(nick || '').trim().slice(0, 24);
  if (!clean) return null;
  if (!state.users[clean]) {
    state.users[clean] = {
      balance: state.config.startingBalance,
      holdings: {},
      history: []
    };
  }
  return clean;
}

function getPublicUser(nick) {
  const u = state.users[nick];
  if (!u) return null;
  return {
    balance: u.balance,
    holdings: u.holdings,
    history: u.history.slice(-20) // last 20
  };
}

function broadcastStocks() {
  io.emit('price:all', { stocks: state.stocks });
}

function setVolatility(ticker, vol) {
  if (!state.stocks[ticker]) return;
  state.stocks[ticker].volatility = clamp(vol, 0.2, 5);
  restartTimer(ticker);
  saveStateDebounced();
  broadcastStocks();
}

function setPrice(ticker, price) {
  if (!state.stocks[ticker]) return;
  state.stocks[ticker].price = round2(Math.max(0.01, price));
  saveStateDebounced();
  broadcastStocks();
}

function createStock(ticker, name, price, volatility=1.0) {
  const T = ticker.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!T || state.stocks[T]) return false;
  state.stocks[T] = {
    name: name || T,
    price: round2(Math.max(0.01, price || 100)),
    basePrice: round2(Math.max(0.01, price || 100)),
    volatility: clamp(volatility, 0.2, 5),
    paused: false
  };
  restartTimer(T);
  saveStateDebounced();
  broadcastStocks();
  return true;
}

function resetAll() {
  // keep existing stocks but reset prices to base and clear users
  for (const t in state.stocks) {
    const s = state.stocks[t];
    s.price = s.basePrice;
    s.paused = false;
    setVolatility(t, s.volatility);
  }
  state.users = {};
  saveStateDebounced();
  broadcastStocks();
}

// ---- Pricing model ----
// Two mechanisms:
// 1) Event impact: each trade nudges price using an exponential impact based on qty, volatility, liquidity.
// 2) Ticks: random micro-changes + gentle mean reversion, tick interval depends on volatility.
const MIN_INTERVAL_MS = 250;
function restartTimer(ticker) {
  const s = state.stocks[ticker];
  if (!s) return;
  // clear existing
  if (state.runtime.timers[ticker]) {
    clearInterval(state.runtime.timers[ticker]);
    delete state.runtime.timers[ticker];
  }
  const interval = Math.max(MIN_INTERVAL_MS, Math.round(state.config.baseTickMs / Math.max(0.2, s.volatility)));
  state.runtime.timers[ticker] = setInterval(() => {
    if (s.paused) return;
    // small random noise scaled by volatility
    const noise = (Math.random() - 0.5) * 0.004 * s.volatility; // +/- 0.2% at vol=1
    // gentle mean reversion toward basePrice
    const meanRev = (s.basePrice - s.price) * 0.01; // pull 1% of gap
    s.price = round2(Math.max(0.01, s.price * (1 + noise) + meanRev));
    io.emit('price:update', { ticker, price: s.price });
    saveStateDebounced();
  }, interval);
}

for (const t in state.stocks) restartTimer(t);

function trade(side, nick, ticker, qty) {
  if (!ensureUser(nick)) return { ok: false, error: '닉네임이 필요해요.' };
  const s = state.stocks[ticker];
  if (!s) return { ok: false, error: '존재하지 않는 종목입니다.' };
  if (s.paused) return { ok: false, error: '이 종목은 일시정지 상태입니다.' };
  qty = Math.floor(Number(qty) || 0);
  if (qty <= 0) return { ok: false, error: '수량은 1 이상이어야 합니다.' };

  const u = state.users[nick];
  const price = s.price;
  const cost = round2(price * qty);

  if (side === 'buy') {
    if (u.balance < cost) return { ok: false, error: '잔액이 부족합니다.' };
    u.balance = round2(u.balance - cost);
    u.holdings[ticker] = (u.holdings[ticker] || 0) + qty;
  } else {
    const have = u.holdings[ticker] || 0;
    if (have < qty) return { ok: false, error: '보유 수량이 부족합니다.' };
    u.holdings[ticker] = have - qty;
    u.balance = round2(u.balance + cost);
  }

  // record
  const rec = { ts: Date.now(), side, ticker, qty, price };
  u.history.push(rec);
  if (u.history.length > 200) u.history.shift();

  // price impact: exponential impact scaled by volatility and inverse liquidity
  const sign = side === 'buy' ? 1 : -1;
  const impact = (qty / Math.max(1, state.config.liquidity)) * s.volatility;
  s.price = round2(Math.max(0.01, s.price * Math.exp(sign * impact)));

  saveStateDebounced();

  // notify
  io.emit('price:update', { ticker, price: s.price });
  return { ok: true, user: getPublicUser(nick), newPrice: s.price };
}

// ---- Sockets (public) ----
io.on('connection', (socket) => {
  let nickname = null;

  socket.on('register', (nickReq) => {
    const nick = ensureUser(nickReq);
    nickname = nick;
    socket.emit('state:init', { stocks: state.stocks, config: state.config, user: getPublicUser(nick) });
    broadcastStocks();
  });

  socket.on('buy', ({ ticker, qty }) => {
    if (!nickname) return;
    const res = trade('buy', nickname, ticker, qty);
    socket.emit('trade:result', res);
    if (res.ok) {
      // update this user's view
      socket.emit('user:update', getPublicUser(nickname));
    }
  });

  socket.on('sell', ({ ticker, qty }) => {
    if (!nickname) return;
    const res = trade('sell', nickname, ticker, qty);
    socket.emit('trade:result', res);
    if (res.ok) {
      socket.emit('user:update', getPublicUser(nickname));
    }
  });

  socket.on('disconnect', () => {});
});

// ---- Sockets (admin namespace) ----
const adminIO = io.of('/admin');
adminIO.on('connection', (socket) => {
  let authed = false;

  socket.on('auth', ({ key }) => {
    if (String(key) === String(ADMIN_KEY)) {
      authed = true;
      socket.emit('auth:ok', { stocks: state.stocks, config: state.config });
    } else {
      socket.emit('auth:fail');
      socket.disconnect(true);
    }
  });

  function guard() { return authed; }

  socket.on('setPrice', ({ ticker, price }) => {
    if (!guard()) return;
    setPrice(ticker, Number(price));
    adminIO.emit('stocks', state.stocks);
  });

  socket.on('setVolatility', ({ ticker, volatility }) => {
    if (!guard()) return;
    setVolatility(ticker, Number(volatility));
    adminIO.emit('stocks', state.stocks);
  });

  socket.on('togglePause', ({ ticker }) => {
    if (!guard()) return;
    const s = state.stocks[ticker];
    if (!s) return;
    s.paused = !s.paused;
    saveStateDebounced();
    adminIO.emit('stocks', state.stocks);
  });

  socket.on('createStock', ({ ticker, name, price, volatility }) => {
    if (!guard()) return;
    const ok = createStock(String(ticker||'').toUpperCase(), name, Number(price), Number(volatility));
    socket.emit('createStock:result', { ok });
  });

  socket.on('resetAll', () => {
    if (!guard()) return;
    resetAll();
    adminIO.emit('stocks', state.stocks);
  });

  socket.on('giveCash', ({ nick, amount }) => {
    if (!guard()) return;
    const uNick = ensureUser(nick);
    if (!uNick) return;
    const u = state.users[uNick];
    u.balance = round2(u.balance + Number(amount || 0));
    saveStateDebounced();
  });
});

// ---- Routes ----
app.get('/health', (_, res) => res.json({ ok: true }));

// ---- Start ----
server.listen(PORT, () => {
  console.log(`Virtual Stock Festival running on http://localhost:${PORT}`);
  console.log(`Admin key is set. Change ADMIN_KEY environment variable for security.`);
});
