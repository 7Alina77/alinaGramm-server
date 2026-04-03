const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// ============ ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============ СОЗДАНИЕ ТАБЛИЦ ============
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        from_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        to_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        from_username VARCHAR(100) NOT NULL,
        to_username VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_from_username ON messages(from_username);
      CREATE INDEX IF NOT EXISTS idx_messages_to_username ON messages(to_username);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    `);
    
    console.log('✅ База данных инициализирована');
  } catch (error) {
    console.error('Ошибка инициализации БД:', error);
  }
};

initDb();

// ============ НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ ============
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ============ API ============

// Загрузка файла
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }
    
    const fileUrl = `${process.env.PUBLIC_URL || 'https://alinagramm-server-production.up.railway.app'}/uploads/${req.file.filename}`;
    
    res.json({
      success: true,
      file: {
        url: fileUrl,
        name: req.file.originalname,
        size: req.file.size,
        type: req.file.mimetype.startsWith('image/') ? 'image' : 'document'
      }
    });
  } catch (error) {
    console.error('Ошибка загрузки файла:', error);
    res.status(500).json({ error: 'Ошибка загрузки файла' });
  }
});

// Статическая раздача файлов
app.use('/uploads', express.static(uploadDir));

// Регистрация
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
  
  try {
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
      [username, hashedPassword]
    );
    
    console.log(`✅ Пользователь "${username}" зарегистрирован`);
    res.json({ success: true, message: 'Регистрация успешна' });
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  console.log(`🔐 Вход: ${username}`);
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Имя и пароль обязательны' });
  }
  
  try {
    const result = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }
    
    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);
    
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    
    await pool.query(
      'UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );
    
    res.json({ success: true, message: 'Вход выполнен', username });
  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение списка пользователей
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT username, created_at, last_seen FROM users ORDER BY username'
    );
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('Ошибка получения пользователей:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// История сообщений
app.post('/api/messages/history', async (req, res) => {
  const { user1, user2 } = req.body;
  
  if (!user1 || !user2) {
    return res.status(400).json({ error: 'Не указаны пользователи' });
  }
  
  try {
    const result = await pool.query(
      `SELECT 
        id, 
        from_username, 
        to_username, 
        message, 
        timestamp,
        CASE 
          WHEN from_username = $1 THEN true 
          ELSE false 
        END as is_me
       FROM messages 
       WHERE (from_username = $1 AND to_username = $2) 
          OR (from_username = $2 AND to_username = $1)
       ORDER BY timestamp ASC
       LIMIT 500`,
      [user1, user2]
    );
    
    const formattedMessages = result.rows.map(msg => ({
      id: msg.id.toString(),
      text: msg.message,
      isMe: msg.is_me,
      from: msg.from_username,
      timestamp: msg.timestamp
    }));
    
    res.json({ success: true, messages: formattedMessages });
  } catch (error) {
    console.error('Ошибка загрузки истории:', error);
    res.status(500).json({ error: 'Ошибка загрузки истории' });
  }
});

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============
const saveMessageToDb = async (from, to, message, timestamp) => {
  try {
    const fromUser = await pool.query('SELECT id FROM users WHERE username = $1', [from]);
    const toUser = await pool.query('SELECT id FROM users WHERE username = $1', [to]);
    
    if (fromUser.rows.length === 0 || toUser.rows.length === 0) {
      console.error('Пользователь не найден в БД');
      return false;
    }
    
    await pool.query(
      `INSERT INTO messages (from_user_id, to_user_id, from_username, to_username, message, timestamp) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fromUser.rows[0].id, toUser.rows[0].id, from, to, message, timestamp]
    );
    
    console.log(`💾 Сообщение сохранено в БД: ${from} -> ${to}`);
    return true;
  } catch (error) {
    console.error('Ошибка сохранения сообщения:', error);
    return false;
  }
};

// ============ SOCKET.IO ============
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('✅ Пользователь подключился:', socket.id);
  
  socket.on('register', async (username) => {
    onlineUsers.set(username, socket.id);
    console.log(`📱 Пользователь "${username}" онлайн. Всего онлайн: ${onlineUsers.size}`);
    
    await pool.query(
      'UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE username = $1',
      [username]
    );
    
    io.emit('onlineUsers', Array.from(onlineUsers.keys()));
  });
  
  socket.on('privateMessage', async (data) => {
    const { to, from, message, timestamp } = data;
    console.log(`💬 Сообщение от ${from} к ${to}: "${message}"`);
    
    const saved = await saveMessageToDb(from, to, message, timestamp);
    
    if (!saved) {
      socket.emit('messageError', { error: 'Не удалось сохранить сообщение' });
      return;
    }
    
    const targetSocketId = onlineUsers.get(to);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('newMessage', { 
        id: Date.now().toString(),
        from, 
        message, 
        timestamp,
        isMe: false
      });
      socket.emit('messageSent', { 
        id: Date.now().toString(),
        to, 
        message, 
        timestamp,
        isMe: true
      });
      console.log(`✅ Сообщение доставлено ${to}`);
    } else {
      console.log(`❌ Пользователь ${to} не в сети, сообщение сохранено в БД`);
      socket.emit('messageSaved', { to, message });
    }
  });
  
  socket.on('disconnect', async () => {
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

// ============ ЗАПУСК СЕРВЕРА ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📡 Ожидаем подключения клиентов...\n`);
});