const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const USERS_FILE = path.join(__dirname, 'users.json');

const loadUsers = () => {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Ошибка загрузки пользователей:', error);
  }
  return {};
};

const saveUsers = (users) => {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    console.log('✅ Пользователи сохранены');
  } catch (error) {
    console.error('Ошибка сохранения пользователей:', error);
  }
};

let users = loadUsers();
console.log(`📋 Загружено ${Object.keys(users).length} пользователей`);

// Регистрация с хэшированием пароля
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  console.log(`📝 Регистрация: ${username}`);
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Имя и пароль обязательны' });
  }
  
  if (username.length < 3) {
    return res.status(400).json({ error: 'Имя должно содержать минимум 3 символа' });
  }
  
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль должен содержать минимум 4 символа' });
  }
  
  if (users[username]) {
    return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });
  }
  
  // Хэшируем пароль
  const hashedPassword = await bcrypt.hash(password, 10);
  
  users[username] = {
    password: hashedPassword,
    createdAt: new Date().toISOString()
  };
  
  saveUsers(users);
  
  res.json({ success: true, message: 'Регистрация успешна' });
});

// Вход с проверкой хэша пароля
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  console.log(`🔐 Вход: ${username}`);
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Имя и пароль обязательны' });
  }
  
  const user = users[username];
  
  if (!user) {
    return res.status(401).json({ error: 'Пользователь не найден' });
  }
  
  // Сравниваем пароль с хэшем
  const isValid = await bcrypt.compare(password, user.password);
  
  if (!isValid) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  
  res.json({ success: true, message: 'Вход выполнен', username });
});

// Остальной код сервера без изменений...
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('✅ Пользователь подключился:', socket.id);
  
  socket.on('register', (username) => {
    onlineUsers.set(username, socket.id);
    console.log(`📱 Пользователь "${username}" онлайн. Всего онлайн: ${onlineUsers.size}`);
    io.emit('onlineUsers', Array.from(onlineUsers.keys()));
  });
  
  socket.on('privateMessage', (data) => {
    const { to, from, message, timestamp } = data;
    console.log(`💬 Сообщение от ${from} к ${to}: "${message}"`);
    
    const targetSocketId = onlineUsers.get(to);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('newMessage', { from, message, timestamp });
      socket.emit('messageSent', { to, message, timestamp });
      console.log(`✅ Сообщение доставлено ${to}`);
    } else {
      console.log(`❌ Пользователь ${to} не в сети`);
      socket.emit('messageNotDelivered', { to, message });
    }
  });
  
  socket.on('disconnect', () => {
    let disconnectedUser = null;
    for (let [username, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        disconnectedUser = username;
        onlineUsers.delete(username);
        break;
      }
    }
    
    if (disconnectedUser) {
      console.log(`🔴 Пользователь "${disconnectedUser}" отключился. Онлайн: ${onlineUsers.size}`);
      io.emit('onlineUsers', Array.from(onlineUsers.keys()));
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Сервер запущен на http://localhost:${PORT}`);
  console.log(`📡 Ожидаем подключения клиентов...\n`);
});