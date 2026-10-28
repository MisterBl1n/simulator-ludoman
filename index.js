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
app.use(express.static('public'));

app.get('/health', (req, res) => res.status(200).send('OK'));

// --- БАЗА ДАННЫХ ---
const users = {
  'Admin': { 
    password: 'admin123', 
    balance: 100000, 
    socketId: null, bet: 0, pendingBet: 0, cashedOut: false, cashoutMult: 0 
  }
}; 

// --- ЛОГИКА ИГРЫ ---
let gameState = { phase: 'waiting', multiplier: 1.00, crashAt: 2.00, timeLeft: 8 };
let activeBets = [];

function startGameLoop() {
  gameState.phase = 'waiting';
  gameState.timeLeft = 8;
  gameState.multiplier = 1.00;
  activeBets = [];
  
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
  // РЕГИСТРАЦИЯ
  socket.on('register', (data) => {
    const { username, password } = data;
    const name = username.trim().substring(0, 15);
    
    if (name.toLowerCase() === 'admin') return socket.emit('auth_error', 'Этот ник зарезервирован!');
    if (users[name]) return socket.emit('auth_error', 'Этот ник уже занят!');
    if (name.length < 2 || password.length < 4) return socket.emit('auth_error', 'Ник > 1 буквы, пароль > 3 символов');

    users[name] = { password, balance: 1000, socketId: socket.id, bet: 0, pendingBet: 0, cashedOut: false, cashoutMult: 0 };
    socket.username = name;
    socket.emit('login_success', { username: name, balance: users[name].balance, isAdmin: false });
    updatePlayersList();
  });

  // ВХОД
  socket.on('login', (data) => {
    const { username, password } = data;
    const name = username.trim();
    
    const user = users[name];
    if (!user || user.password !== password) return socket.emit('auth_error', 'Неверный логин или пароль');

    user.socketId = socket.id;
    socket.username = name;
    socket.emit('login_success', { username: name, balance: user.balance, isAdmin: name === 'Admin' });
    updatePlayersList();
  });

  // СТАВКИ
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

  // АДМИНКА (Внутри игры)
  socket.on('admin_get_users', () => {
    if (socket.username !== 'Admin') return;
    const list = Object.keys(users).map(name => ({ name, balance: users[name].balance }));
    socket.emit('admin_users_list', list);
  });

  socket.on('admin_change_balance', (data) => {
    if (socket.username !== 'Admin') return;
    const { targetName, amount, action } = data;
    if (!users[targetName]) return socket.emit('toast', { msg: 'Игрок не найден', type: 'bad' });

    if (action === 'add') users[targetName].balance += parseFloat(amount);
    if (action === 'set') users[targetName].balance = parseFloat(amount);

    if (users[targetName].socketId) {
      io.to(users[targetName].socketId).emit('balance_update', users[targetName].balance);
      io.to(users[targetName].socketId).emit('toast', { msg: 'Админ изменил ваш баланс!', type: 'gold' });
    }
    socket.emit('toast', { msg: 'Баланс ' + targetName + ' обновлен!', type: 'good' });
    socket.emit('admin_users_list', Object.keys(users).map(name => ({ name, balance: users[name].balance })));
  });

  socket.on('disconnect', () => {
    if (socket.username && users[socket.username]) {
      users[socket.username].socketId = null;
    }
    updatePlayersList();
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  startGameLoop();
});
