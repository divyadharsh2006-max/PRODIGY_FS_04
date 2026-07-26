// server.js - Express + Socket.IO real-time chat backend
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------------- Auth helpers ----------------
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------- REST: Auth ----------------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'Username and password (min 4 chars) required' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  const user = { id: info.lastInsertRowid, username };
  const token = signToken(user);
  res.json({ token, user });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username } });
});

// ---------------- REST: Rooms & History ----------------
app.get('/api/rooms', authMiddleware, (req, res) => {
  const rooms = db.prepare('SELECT id, name FROM rooms ORDER BY name').all();
  res.json(rooms);
});

app.get('/api/rooms/:roomId/messages', authMiddleware, (req, res) => {
  const msgs = db.prepare(
    `SELECT id, user_id, username, content, file_url, file_name, created_at
     FROM room_messages WHERE room_id = ? ORDER BY id ASC LIMIT 200`
  ).all(req.params.roomId);
  res.json(msgs);
});

app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username FROM users WHERE id != ? ORDER BY username')
    .all(req.user.id);
  res.json(users);
});

app.get('/api/private/:otherUserId/messages', authMiddleware, (req, res) => {
  const otherId = Number(req.params.otherUserId);
  const msgs = db.prepare(
    `SELECT id, sender_id, receiver_id, content, file_url, file_name, created_at
     FROM private_messages
     WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
     ORDER BY id ASC LIMIT 200`
  ).all(req.user.id, otherId, otherId, req.user.id);
  res.json(msgs);
});

// ---------------- Socket.IO real-time layer ----------------
// Track online users: userId -> Set of socket ids (supports multiple tabs/devices)
const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload; // { id, username }
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

function broadcastPresence() {
  const list = Array.from(onlineUsers.keys());
  io.emit('presence:update', list);
}

io.on('connection', (socket) => {
  const { id: userId, username } = socket.user;

  // Track presence
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);
  broadcastPresence();

  // ---- Room events ----
  socket.on('room:join', (roomId) => {
    socket.join(`room:${roomId}`);
    socket.to(`room:${roomId}`).emit('room:system', {
      message: `${username} joined the room`,
      roomId,
    });
  });

  socket.on('room:leave', (roomId) => {
    socket.leave(`room:${roomId}`);
    socket.to(`room:${roomId}`).emit('room:system', {
      message: `${username} left the room`,
      roomId,
    });
  });

  socket.on('room:message', ({ roomId, content, fileUrl, fileName }) => {
    if (!content && !fileUrl) return;
    const info = db.prepare(
      `INSERT INTO room_messages (room_id, user_id, username, content, file_url, file_name)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(roomId, userId, username, content || null, fileUrl || null, fileName || null);

    const message = {
      id: info.lastInsertRowid,
      roomId,
      user_id: userId,
      username,
      content,
      file_url: fileUrl || null,
      file_name: fileName || null,
      created_at: new Date().toISOString(),
    };
    io.to(`room:${roomId}`).emit('room:message', message);
  });

  socket.on('room:typing', ({ roomId, isTyping }) => {
    socket.to(`room:${roomId}`).emit('room:typing', { userId, username, isTyping });
  });

  // ---- Private message events ----
  socket.on('private:message', ({ toUserId, content, fileUrl, fileName }) => {
    if (!content && !fileUrl) return;
    const info = db.prepare(
      `INSERT INTO private_messages (sender_id, receiver_id, content, file_url, file_name)
       VALUES (?, ?, ?, ?, ?)`
    ).run(userId, toUserId, content || null, fileUrl || null, fileName || null);

    const message = {
      id: info.lastInsertRowid,
      sender_id: userId,
      receiver_id: toUserId,
      username,
      content,
      file_url: fileUrl || null,
      file_name: fileName || null,
      created_at: new Date().toISOString(),
    };

    // Send to all sockets of the receiver (if online) and echo back to sender
    const receiverSockets = onlineUsers.get(toUserId);
    if (receiverSockets) {
      receiverSockets.forEach((sid) => io.to(sid).emit('private:message', message));
    }
    socket.emit('private:message', message);
  });

  socket.on('private:typing', ({ toUserId, isTyping }) => {
    const receiverSockets = onlineUsers.get(toUserId);
    if (receiverSockets) {
      receiverSockets.forEach((sid) =>
        io.to(sid).emit('private:typing', { fromUserId: userId, username, isTyping })
      );
    }
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    const set = onlineUsers.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) onlineUsers.delete(userId);
    }
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`Chat server running at http://localhost:${PORT}`);
});
