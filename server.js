// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: false,
  cors: { origin: '*' }
});

const SHELL = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

class RingBuffer {
  constructor(limitBytes) {
    this.buf = Buffer.allocUnsafe(limitBytes);
    this.limit = limitBytes;
    this.start = 0;
    this.len = 0;
  }
  append(input) {
    const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    if (b.length >= this.limit) {
      b.copy(this.buf, 0, b.length - this.limit);
      this.start = 0;
      this.len = this.limit;
      return;
    }
    const free = this.limit - this.len;
    if (b.length > free) {
      this.start = (this.start + (b.length - free)) % this.limit;
      this.len = this.limit;
    } else {
      this.len += b.length;
    }
    const writePos = (this.start + this.len - b.length) % this.limit;
    const firstPart = Math.min(b.length, this.limit - writePos);
    b.copy(this.buf, writePos, 0, firstPart);
    if (firstPart < b.length) {
      b.copy(this.buf, 0, firstPart);
    }
  }
  toString(enc = 'utf8') {
    if (this.len === 0) return '';
    if (this.start + this.len <= this.limit) {
      return this.buf.slice(this.start, this.start + this.len).toString(enc);
    } else {
      const tailLen = (this.start + this.len) - this.limit;
      return Buffer.concat([
        this.buf.slice(this.start, this.limit),
        this.buf.slice(0, tailLen)
      ]).toString(enc);
    }
  }
}

const sessions = new Map();
const HISTORY_LIMIT = 1024 * 512; // 512KB per session

function getNextSessionNumber() {
    const usedNumbers = Array.from(sessions.values())
        .map(s => {
            const match = s.name.match(/^Session (\d+)$/);
            return match ? parseInt(match[1], 10) : null;
        })
        .filter(n => n !== null)
        .sort((a, b) => a - b);
    
    let nextNumber = 1;
    for (const num of usedNumbers) {
        if (num === nextNumber) {
            nextNumber++;
        } else {
            break; // Found a gap
        }
    }
    return nextNumber;
}

function createSession(isInitial = false) {
  const id = uuidv4();
  let ptyProc;

  try {
    ptyProc = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: process.env.HOME || process.cwd(),
      env: process.env
    });
  } catch (err) {
    console.error('Failed to spawn PTY:', err);
    return null;
  }

  const sessionNumber = getNextSessionNumber();
  const session = {
    id,
    name: `Session ${sessionNumber}`,
    pty: ptyProc,
    history: new RingBuffer(HISTORY_LIMIT),
  };

  ptyProc.on('data', (d) => {
    try {
      session.history.append(d);
      io.to(session.id).emit('output', d);
    } catch (err) {
      console.error(`Error on PTY data for session ${session.id}:`, err);
    }
  });

  ptyProc.on('exit', (code) => {
    console.log(`PTY for session ${session.id} exited with code ${code}`);
    sessions.delete(session.id);
    io.emit('session-closed', { id: session.id, name: session.name });
  });

  sessions.set(id, session);
  console.log(`Created session ${session.name} (${session.id})`);
  io.emit('session-created', { id: session.id, name: session.name });

  if (isInitial) {
    setTimeout(() => {
        if (session.pty) {
          console.log('Executing startup commands for initial session...');
          try {
            session.pty.write('cd ~/project/src/ && bash root.sh\r');
          } catch(err) {
            console.error(`PTY [${session.id}] initial write error`, err);
          }
        }
    }, 500);
  }

  return session;
}

// Initialize with one session
if (sessions.size === 0) {
    createSession(true);
}

app.use(express.static('public'));

function createBucket(capacity = 32768, refillRate = 16384) {
  let tokens = capacity; let last = Date.now();
  return {
    take(n = 1) {
      const now = Date.now(); const delta = now - last;
      if (delta > 0) {
        tokens = Math.min(capacity, tokens + (delta / 1000) * refillRate);
        last = now;
      }
      if (tokens >= n) { tokens -= n; return true; }
      return false;
    }
  };
}

io.on('connection', (socket) => {
  console.log('Client connected', socket.id);

  const sessionList = Array.from(sessions.values()).map(s => ({ id: s.id, name: s.name }));
  socket.emit('sessions-list', sessionList);

  const bucket = createBucket(); // Use improved defaults

  socket.on('switch-session', (sessionId) => {
    socket.rooms.forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });

    const session = sessions.get(sessionId);
    if (session) {
      socket.join(sessionId);
      console.log(`Socket ${socket.id} switched to session ${sessionId}`);
      const h = session.history.toString();
      if (h.length) socket.emit('history', h);
    }
  });

  socket.on('create-session', (callback) => {
    const newSession = createSession(false);
    if (newSession && typeof callback === 'function') {
        callback({ id: newSession.id, name: newSession.name });
    }
  });

  socket.on('close-session', (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      console.log(`Closing session ${sessionId} by client request.`);
      session.pty.kill();
    }
  });

  socket.on('input', ({ sessionId, data }) => {
    const session = sessions.get(sessionId);
    if (!session || !session.pty) return;
    const bytes = Buffer.byteLength(String(data), 'utf8');
    if (!bucket.take(bytes)) return;
    try {
      session.pty.write(String(data));
    } catch (err) {
      console.error(`PTY [${session.id}] write error`, err);
    }
  });

  socket.on('resize', ({ sessionId, cols, rows }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    cols = Number(cols) || 80;
    rows = Number(rows) || 30;
    if (cols < 40 || cols > 1000 || rows < 10 || rows > 400) return;
    try { session.pty.resize(cols, rows); } catch (e) { /* ignore */ }
  });

  socket.on('disconnect', (reason) => {
    console.log('Client disconnected', socket.id, reason);
  });
});

process.on('uncaughtException', (err) => { console.error('Uncaught exception', err); });
process.on('unhandledRejection', (r) => { console.error('Unhandled rejection', r); });

function shutdown() {
  console.log('Shutdown');
  sessions.forEach(session => {
    try { if (session.pty) session.pty.kill(); } catch (e) {}
  });
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
