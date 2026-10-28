const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Отдаем файлы сайта

app.get('/health', (req, res) => res.status(200).send('OK'));

// --- БАЗА ДАННЫХ ---
const users = {}; // { username: { balance, socketId, pendingBet, bet, cashedOut, cashoutMult } }
const ADMIN_SECRET = 'admin123'; 

// --- ЛОГИКА ИГРЫ ---
let gameState = {
  phase: 'waiting', multiplier: 1.00, crashAt: 2.00, timeLeft: 8
};
let activeBets = []; // [{ username, bet, cashedOut, cashoutMult }]

function startGameLoop() {
  gameState.phase = 'waiting';
  gameState.timeLeft = 8;
  gameState.multiplier = 1.00;
  activeBets = [];
  
  // Переносим отложенные ставки
  for (const name in users) {
    if (users[name].pendingBet > 0) {
      if (users[name].balance >= users[name].pendingBet) {
        users[name].balance -= users[name].pendingBet;
        users[name].bet = users[name].pendingBet;
        users[name].cashedOut = false;
        users[name].pendingBet = 0;
        if (users[name].socketId) {
          io.to(users[name].socketId).emit('balance_update', users[name].balance);
          io.to(users[name].socketId).emit('toast', { msg: 'Ставка принята: ' + users[name].bet + ' Р', type: 'good' });
        }
      } else {
        users[name].pendingBet = 0;
        if (users[name].socketId) io.to(users[name].socketId).emit('toast', { msg: 'Не хватило на отложенную ставку', type: 'bad' });
      }
    } else {
      users[name].bet = 0;
      users[name].cashedOut = false;
    }
  }

  updatePlayersList();
  io.emit('game_state', gameState);

  const waitInterval = setInterval(() => {
    gameState.timeLeft -= 1;
    io.emit('game_state', gameState);
    if (gameState.timeLeft <= 0) {
      clearInterval(waitInterval);
      startFlyingPhase();
    }
  }, 1000);
}

function startFlyingPhase() {
  gameState.phase = 'flying';
  gameState.multiplier = 1.00;
  gameState.crashAt = Math.min(1000, Math.max(1.01, 0.97 / (1 - Math.random())));
  io.emit('game_state', gameState);

  const startTime = Date.now();
  const flyInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    let mult = Math.exp(0.42 * elapsed);
    
    if (mult >= gameState.crashAt) {
      mult = gameState.crashAt;
      gameState.multiplier = mult;
      clearInterval(flyInterval);
      crashGame();
    } else {
      gameState.multiplier = mult;
      io.emit('multiplier_update', mult);
    }
  }, 50);
}

function crashGame() {
  gameState.phase = 'crashed';
  io.emit('game_crash', { crashAt: gameState.crashAt });
  
  for (const name in users) {
    if (users[name].bet > 0 && !users[name].cashedOut) {
      users[name].bet = 0;
    }
  }
  updatePlayersList();
  setTimeout(startGameLoop, 3000);
}

function updatePlayersList() {
  activeBets = [];
  let totalBank = 0;
  for (const name in users) {
    if (users[name].bet > 0) {
      activeBets.push({
        name: name, bet: users[name].bet, cashedOut: users[name].cashedOut, cashoutMult: users[name].cashoutMult || 0
      });
      totalBank += users[name].bet;
    }
  }
  io.emit('players_update', { players: activeBets, totalBank });
}

// --- СОКЕТЫ ---
io.on('connection', (socket) => {
  socket.on('login', (username) => {
    username = username.trim().substring(0, 15);
    if (!username) return;

    if (!users[username]) {
      users[username] = { balance: 1000, bet: 0, pendingBet: 0, cashedOut: false, cashoutMult: 0 };
    }
    users[username].socketId = socket.id;
    socket.username = username;

    socket.emit('login_success', { username, balance: users[username].balance, state: gameState });
    updatePlayersList();
  });

  socket.on('place_bet', (amount) => {
    const name = socket.username;
    if (!name || !users[name]) return;
    const p = users[name];
    amount = parseFloat(amount);

    if (gameState.phase === 'waiting' && p.bet === 0) {
      if (p.balance >= amount) {
        p.balance -= amount;
        p.bet = amount;
        p.cashedOut = false;
        socket.emit('balance_update', p.balance);
        socket.emit('toast', { msg: 'Ставка принята: ' + amount + ' Р', type: 'good' });
        updatePlayersList();
      } else socket.emit('toast', { msg: 'Недостаточно средств', type: 'bad' });
    } else if (p.bet === 0) {
      if (p.balance >= amount) {
        p.pendingBet = amount;
        socket.emit('toast', { msg: 'Забронировано на след. раунд: ' + amount + ' Р', type: 'good' });
      } else socket.emit('toast', { msg: 'Недостаточно средств', type: 'bad' });
    }
  });

  socket.on('cash_out', () => {
    const name = socket.username;
    if (!name || !users[name]) return;
    const p = users[name];
    
    if (p.bet > 0 && !p.cashedOut && gameState.phase === 'flying') {
      p.cashedOut = true;
      p.cashoutMult = gameState.multiplier;
      const win = Math.floor(p.bet * gameState.multiplier);
      p.balance += win;
      socket.emit('balance_update', p.balance);
      socket.emit('cashout_success', { win, mult: gameState.multiplier });
      updatePlayersList();
    }
  });

  socket.on('disconnect', () => {
    if (socket.username && users[socket.username]) {
      users[socket.username].socketId = null;
    }
    updatePlayersList();
  });
});

// --- АДМИН API ---
app.post('/api/admin/balance', (req, res) => {
  const { secret, playerName, amount, action } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Неверный пароль' });

  if (!users[playerName]) return res.status(404).json({ error: 'Игрок не найден' });

  if (action === 'add') users[playerName].balance += parseFloat(amount);
  if (action === 'set') users[playerName].balance = parseFloat(amount);

  if (users[playerName].socketId) {
    io.to(users[playerName].socketId).emit('balance_update', users[playerName].balance);
    io.to(users[playerName].socketId).emit('toast', { msg: 'Администратор изменил ваш баланс!', type: 'gold' });
  }
  
  res.json({ success: true, newBalance: users[playerName].balance });
});

app.get('/api/admin/players', (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Неверный пароль' });
  const list = Object.keys(users).map(name => ({ 
    name: name, 
    balance: users[name].balance,
    online: !!users[name].socketId
  }));
  res.json(list);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  startGameLoop();
});
