// app.js - Client-side logic for the real-time chat app

const API = ''; // same origin
let token = localStorage.getItem('chat_token') || null;
let currentUser = JSON.parse(localStorage.getItem('chat_user') || 'null');
let socket = null;

let activeContext = null; // { type: 'room'|'private', id, name }
let onlineUserIds = new Set();
let typingTimeout = null;

// ---------------- Auth screen wiring ----------------
const authScreen = document.getElementById('auth-screen');
const chatScreen = document.getElementById('chat-screen');

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('login-form').classList.toggle('hidden', btn.dataset.tab !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', btn.dataset.tab !== 'register');
  });
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setSession(data.token, data.user);
    startApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;
  const errEl = document.getElementById('register-error');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    setSession(data.token, data.user);
    startApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function setSession(t, user) {
  token = t;
  currentUser = user;
  localStorage.setItem('chat_token', t);
  localStorage.setItem('chat_user', JSON.stringify(user));
}

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('chat_token');
  localStorage.removeItem('chat_user');
  if (socket) socket.disconnect();
  location.reload();
});

// ---------------- App bootstrap ----------------
async function apiFetch(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}

async function startApp() {
  authScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  document.getElementById('current-username').textContent = currentUser.username;

  connectSocket();
  await loadRooms();
  await loadUsers();
}

function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('connect_error', (err) => {
    console.error('Socket auth error:', err.message);
  });

  socket.on('presence:update', (userIds) => {
    onlineUserIds = new Set(userIds);
    refreshUserPresenceUI();
  });

  socket.on('room:message', (msg) => {
    if (activeContext?.type === 'room' && String(activeContext.id) === String(msg.roomId)) {
      renderMessage(msg, msg.user_id === currentUser.id);
    }
  });

  socket.on('room:system', ({ message, roomId }) => {
    if (activeContext?.type === 'room' && String(activeContext.id) === String(roomId)) {
      renderSystemMessage(message);
    }
  });

  socket.on('room:typing', ({ username, isTyping, userId }) => {
    if (userId === currentUser.id) return;
    if (activeContext?.type === 'room') {
      setTypingIndicator(isTyping ? `${username} is typing...` : '');
    }
  });

  socket.on('private:message', (msg) => {
    const otherId = msg.sender_id === currentUser.id ? msg.receiver_id : msg.sender_id;
    if (activeContext?.type === 'private' && String(activeContext.id) === String(otherId)) {
      renderMessage(msg, msg.sender_id === currentUser.id);
    }
  });

  socket.on('private:typing', ({ fromUserId, username, isTyping }) => {
    if (activeContext?.type === 'private' && String(activeContext.id) === String(fromUserId)) {
      setTypingIndicator(isTyping ? `${username} is typing...` : '');
    }
  });
}

// ---------------- Rooms ----------------
async function loadRooms() {
  const rooms = await apiFetch('/api/rooms');
  const list = document.getElementById('room-list');
  list.innerHTML = '';
  rooms.forEach((room) => {
    const li = document.createElement('li');
    li.textContent = `# ${room.name}`;
    li.dataset.roomId = room.id;
    li.addEventListener('click', () => openRoom(room));
    list.appendChild(li);
  });
}

async function openRoom(room) {
  if (activeContext?.type === 'room' && activeContext.id === room.id) return;
  if (activeContext?.type === 'room') socket.emit('room:leave', activeContext.id);

  activeContext = { type: 'room', id: room.id, name: room.name };
  highlightActiveSidebarItem();
  document.getElementById('chat-title').textContent = `# ${room.name}`;
  setTypingIndicator('');

  socket.emit('room:join', room.id);
  const messages = await apiFetch(`/api/rooms/${room.id}/messages`);
  renderAllMessages(messages, (m) => m.user_id === currentUser.id);
}

// ---------------- Direct messages ----------------
async function loadUsers() {
  const users = await apiFetch('/api/users');
  const list = document.getElementById('user-list');
  list.innerHTML = '';
  users.forEach((user) => {
    const li = document.createElement('li');
    li.dataset.userId = user.id;
    const dot = document.createElement('span');
    dot.className = 'presence-dot';
    dot.id = `presence-${user.id}`;
    li.appendChild(dot);
    li.appendChild(document.createTextNode(user.username));
    li.addEventListener('click', () => openPrivateChat(user));
    list.appendChild(li);
  });
  refreshUserPresenceUI();
}

function refreshUserPresenceUI() {
  document.querySelectorAll('#user-list li').forEach((li) => {
    const dot = li.querySelector('.presence-dot');
    if (onlineUserIds.has(Number(li.dataset.userId))) {
      dot.classList.add('online');
    } else {
      dot.classList.remove('online');
    }
  });
}

async function openPrivateChat(user) {
  if (activeContext?.type === 'room') socket.emit('room:leave', activeContext.id);
  activeContext = { type: 'private', id: user.id, name: user.username };
  highlightActiveSidebarItem();
  document.getElementById('chat-title').textContent = `@ ${user.username}`;
  setTypingIndicator('');

  const messages = await apiFetch(`/api/private/${user.id}/messages`);
  renderAllMessages(messages, (m) => m.sender_id === currentUser.id);
}

function highlightActiveSidebarItem() {
  document.querySelectorAll('.sidebar-section li').forEach((li) => li.classList.remove('active'));
  if (!activeContext) return;
  const selector =
    activeContext.type === 'room'
      ? `#room-list li[data-room-id="${activeContext.id}"]`
      : `#user-list li[data-user-id="${activeContext.id}"]`;
  document.querySelector(selector)?.classList.add('active');
}

// ---------------- Messages rendering ----------------
const messagesEl = document.getElementById('messages');

function renderAllMessages(messages, isOwnFn) {
  messagesEl.innerHTML = '';
  messages.forEach((m) => renderMessage(m, isOwnFn(m)));
}

function renderMessage(msg, isOwn) {
  const div = document.createElement('div');
  div.className = `msg ${isOwn ? 'own' : ''}`;

  const meta = document.createElement('span');
  meta.className = 'meta';
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = `${isOwn ? 'You' : msg.username || ''} · ${time}`;
  div.appendChild(meta);

  if (msg.content) {
    const textNode = document.createElement('div');
    textNode.textContent = msg.content;
    div.appendChild(textNode);
  }

  if (msg.file_url) {
    const wrap = document.createElement('div');
    wrap.className = 'file-attachment';
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(msg.file_name || '') || msg.file_url.startsWith('data:image');
    if (isImage) {
      const img = document.createElement('img');
      img.src = msg.file_url;
      wrap.appendChild(img);
    } else {
      const link = document.createElement('a');
      link.href = msg.file_url;
      link.download = msg.file_name || 'file';
      link.textContent = `📄 ${msg.file_name || 'Download file'}`;
      wrap.appendChild(link);
    }
    div.appendChild(wrap);
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setTypingIndicator(text) {
  document.getElementById('typing-indicator').textContent = text;
}

// ---------------- Sending messages ----------------
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const fileInput = document.getElementById('file-input');
const filePreview = document.getElementById('file-preview');

let pendingFile = null; // { dataUrl, name }

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    alert('Please choose a file under 3MB (demo limit for inline transfer).');
    fileInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingFile = { dataUrl: reader.result, name: file.name };
    filePreview.textContent = `Attached: ${file.name}`;
    filePreview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
});

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const content = messageInput.value.trim();
  if (!content && !pendingFile) return;
  if (!activeContext) return;

  const payload = { content, fileUrl: pendingFile?.dataUrl, fileName: pendingFile?.name };

  if (activeContext.type === 'room') {
    socket.emit('room:message', { roomId: activeContext.id, ...payload });
    socket.emit('room:typing', { roomId: activeContext.id, isTyping: false });
  } else {
    socket.emit('private:message', { toUserId: activeContext.id, ...payload });
    socket.emit('private:typing', { toUserId: activeContext.id, isTyping: false });
  }

  messageInput.value = '';
  pendingFile = null;
  fileInput.value = '';
  filePreview.classList.add('hidden');
});

messageInput.addEventListener('input', () => {
  if (!activeContext) return;
  const isTyping = messageInput.value.length > 0;

  if (activeContext.type === 'room') {
    socket.emit('room:typing', { roomId: activeContext.id, isTyping });
  } else {
    socket.emit('private:typing', { toUserId: activeContext.id, isTyping });
  }

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    if (activeContext.type === 'room') {
      socket.emit('room:typing', { roomId: activeContext.id, isTyping: false });
    } else {
      socket.emit('private:typing', { toUserId: activeContext.id, isTyping: false });
    }
  }, 2000);
});

// ---------------- Init ----------------
if (token && currentUser) {
  startApp();
}
