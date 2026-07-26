# PRODIGY_FS_04 — Real-Time Chat Application

A real-time chat application built with **WebSockets (Socket.IO)** that lets users create accounts, join chat rooms, send private messages, and exchange text messages instantly.

## Features

- **User accounts** — register and log in securely (passwords hashed with bcrypt, sessions handled via JWT)
- **Chat rooms** — join shared rooms (General, Random, Tech Talk) and chat in real time
- **Private messaging** — start 1-to-1 direct conversations with any other user
- **Chat history** — past messages are saved and loaded when you open a room or DM
- **Presence indicators** — see who's currently online (live green/gray dot)
- **Typing indicators** — see when the other person is typing
- **File sharing** — attach and send images or files directly in a chat

## Tech Stack

- **Backend:** Node.js, Express, Socket.IO
- **Database:** SQLite (via Node's built-in `node:sqlite` module — no external database setup required)
- **Auth:** JWT + bcrypt
- **Frontend:** HTML, CSS, vanilla JavaScript

## Requirements

- Node.js **v22.5.0 or later** (for built-in SQLite support)

## Getting Started

1. Clone the repository:
```bash
   git clone https://github.com/divyadharsh2006-max/PRODIGY_FS_04.git
   cd PRODIGY_FS_04
```

2. Install dependencies:
```bash
   npm install
```

3. Start the server:
```bash
   npm start
```

4. Open your browser to:
http://localhost:3000


5. Register an account. To test real-time chat, open a second browser tab (or an incognito window), register a second account, and start chatting between the two.

## Project Structure

├── server.js # Express server + Socket.IO event handlers
├── db.js # SQLite database setup and schema
├── package.json
└── public/
├── index.html # Main app UI
├── css/
│ └── style.css
└── js/
└── app.js # Client-side logic (auth, sockets, rendering)

## Notes

- The database file (`chat.db`) is created automatically on first run and is excluded from version control.
- File sharing uses base64 encoding over the WebSocket connection, suitable for small files/images (under 3MB) as a demo implementation.
