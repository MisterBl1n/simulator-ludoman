const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Разрешаем подключения с любых сайтов
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Эндпоинт для проверки работоспособности (чтобы сервер не засыпал)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Обработка подключений игроков
io.on('connection', (socket) => {
  console.log('✅ Игрок подключился:', socket.id);

  socket.on('disconnect', () => {
    console.log('❌ Игрок отключился:', socket.id);
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
