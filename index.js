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

// Эндпоинт для проверки работоспособности (чтобы сервер не засыпал)
app.get('/health', (req, res) => res.status(200).send('OK'));

// --- БАЗА ДАННЫХ В ПАМЯТИ ---
const players = {}; // { socketId: { name, balance, bet, cashedOut, pendingBet } }
const ADMIN_SECRET = 'admin123'; // Секретный ключ для админки

// --- ЛОГИКА ИГРЫ РАКЕТКА ---
let gameState = {
  phase: 'waiting', // waiting, flying, crashed
  multiplier: 1.00,
  crashAt: 2.00,
  timeLeft: 8,
  players: []
};

function startGameLoop() {
  // Фаза ожидания ставок
  gameState.phase = 'waiting';
  gameState.timeLeft = 8;
  gameState.multiplier = 1.00;
  gameState.players = [];
  
  // Переносим отложенные ставки в текущий раунд
  for (const id in players) {
    if (players[id].pendingBet > 0) {
      if (players[id].balance >= players[id].pendingBet) {
        players[id].balance -= players[id].pendingBet;
        players[id].bet = players[id].pendingBet;
        players[id].cashedOut = false;
        players[id].pendingBet = 0;
        io.to(id).emit('balance_update', players[id].balance);
        io.to(id).emit('toast', { msg: 'Ставка принята: ' + players[id].bet + ' Р', type: 'good' });
      } else {
        players[id].pendingBet = 0;
        io.to(id).emit('toast', { msg: 'Не хватило рублей на отложенную ставку', type: 'bad' });
      }
    } else {
      players[id].bet = 0;
      players[id].cashedOut = false;
    }
  }

  updatePlayersList();
  io.emit('game_state', gameState);

  // Таймер ожидания
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
  // Генерация краша (математика как в оригинале)
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
  }, 50); // 20 обновлений в секунду
}

function crashGame() {
  gameState.phase = 'crashed';
  io.emit('game_crash', { crashAt: gameState.crashAt });
  
  // Сбрасываем тех, кто не успел забрать
  for (const id in players) {
    if (players[id].bet > 0 && !players[id].cashedOut) {
      players[id].bet = 0;
    }
  }
  updatePlayersList();
  
  setTimeout(startGameLoop, 3000); // Пауза 3 секунды перед новым раундом
}

function updatePlayersList() {
  const activePlayers = [];
  let totalBank = 0;
  for (const id in players) {
    if (players[id].bet > 0) {
      activePlayers.push({
        name: players[id].name,
        bet: players[id].bet,
        cashedOut: players[id].cashedOut,
        cashoutMult: players[id].cashoutMult || 0
      });
      totalBank += players[id].bet;
    }
  }
  io.emit('players_update', { players: activePlayers, totalBank });
}

// --- СОКЕТЫ ---
io.on('connection', (socket) => {
  // При подключении даем игроку стартовый баланс
  players[socket.id] = {
    name: 'Игрок_' + Math.floor(Math.random() * 1000),
    balance: 1000,
    bet: 0,
    pendingBet: 0,
    cashedOut: false
  };

  socket.emit('init', { balance: players[socket.id].balance, state: gameState });

  socket.on('place_bet', (amount) => {
    const p = players[socket.id];
    if (!p) return;
    amount = parseFloat(amount);

    if (gameState.phase === 'waiting' && p.bet === 0) {
      if (p.balance >= amount) {
        p.balance -= amount;
        p.bet = amount;
        p.cashedOut = false;
        socket.emit('balance_update', p.balance);
        socket.emit('toast', { msg: 'Ставка принята: ' + amount + ' Р', type: 'good' });
        updatePlayersList();
      } else {
        socket.emit('toast', { msg: 'Недостаточно средств', type: 'bad' });
      }
    } else if (p.bet === 0) {
      // Ставка на следующий раунд
      if (p.balance >= amount) {
        p.pendingBet = amount;
        socket.emit('toast', { msg: 'Забронировано на след. раунд: ' + amount + ' Р', type: 'good' });
      } else {
        socket.emit('toast', { msg: 'Недостаточно средств', type: 'bad' });
      }
    }
  });

  socket.on('cash_out', () => {
    const p = players[socket.id];
    if (p && p.bet > 0 && !p.cashedOut && gameState.phase === 'flying') {
      p.cashedOut = true;
      p.cashoutMult = gameState.multiplier;
      const win = Math.floor(p.bet * gameState.multiplier);
      p.balance += win;
      socket.emit('balance_update', p.balance);
      socket.emit('cashout_success', { win, mult: gameState.multiplier });
      updatePlayersList();
    }
  });

  socket.on('set_name', (name) => {
    if (players[socket.id]) players[socket.id].name = name.substring(0, 15);
    updatePlayersList();
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    updatePlayersList();
  });
});

// --- АДМИН ПАНЕЛЬ (API) ---
app.post('/api/admin/balance', (req, res) => {
  const { secret, playerName, amount, action } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Неверный пароль' });

  let targetId = null;
  for (const id in players) {
    if (players[id].name === playerName) { targetId = id; break; }
  }

  if (!targetId) return res.status(404).json({ error: 'Игрок не найден' });

  if (action === 'add') players[targetId].balance += parseFloat(amount);
  if (action === 'set') players[targetId].balance = parseFloat(amount);

  io.to(targetId).emit('balance_update', players[targetId].balance);
  io.to(targetId).emit('toast', { msg: 'Администратор изменил ваш баланс!', type: 'gold' });
  
  res.json({ success: true, newBalance: players[targetId].balance });
});

app.get('/api/admin/players', (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Неверный пароль' });
  const list = Object.values(players).map(p => ({ name: p.name, balance: p.balance }));
  res.json(list);
});

// Запуск
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  startGameLoop();
});
