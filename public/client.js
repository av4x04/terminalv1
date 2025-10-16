// public/client.js
const term = new Terminal({
  theme: {
    background: 'transparent',
    foreground: '#e6eef2',
    cursor: '#00d084',
    selection: 'rgba(0, 208, 132, 0.3)',
  },
  fontSize: 14,
  fontFamily: 'Menlo, "DejaVu Sans Mono", Consolas, "Lucida Console", monospace',
  cursorBlink: true,
  cursorStyle: 'block',
  allowTransparency: true
});
term.open(document.getElementById('terminal'));

const socket = io({ transports: ['websocket'] });

// --- State Management ---
let sessions = new Map();
let activeSessionId = null;

// --- DOM Elements ---
const statusText = document.getElementById('status-text');
const tabsContainer = document.getElementById('terminal-tabs-container');

// --- Session & UI Management ---
function renderTabs() {
  tabsContainer.innerHTML = '';
  
  sessions.forEach(session => {
    const tab = document.createElement('button');
    tab.className = 'tab-btn';
    tab.dataset.sessionId = session.id;
    tab.textContent = session.name;
    if (session.id === activeSessionId) {
      tab.classList.add('active');
    }

    const closeBtn = document.createElement('i');
    closeBtn.className = 'fas fa-times close-tab-btn';
    closeBtn.title = 'Đóng phiên';
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      if (sessions.size > 1 && confirm(`Bạn có chắc muốn đóng "${session.name}" không?`)) {
        socket.emit('close-session', session.id);
      }
    };

    if (sessions.size > 1) {
      tab.appendChild(closeBtn);
    }

    tab.onclick = () => {
      if (session.id !== activeSessionId) {
        switchSession(session.id);
      }
    };
    tabsContainer.appendChild(tab);
  });

  const addSessionBtn = document.createElement('button');
  addSessionBtn.className = 'add-tab-btn';
  addSessionBtn.title = 'Phiên mới';
  addSessionBtn.textContent = '+';
  addSessionBtn.onclick = () => {
    socket.emit('create-session', (newSession) => {
        if (newSession) {
            console.log('Server đã xác nhận tạo phiên:', newSession.name);
        }
    });
  };
  tabsContainer.appendChild(addSessionBtn);
}

function switchSession(sessionId) {
  if (!sessions.has(sessionId) || sessionId === activeSessionId) return;
  
  activeSessionId = sessionId;
  socket.emit('switch-session', sessionId);
  term.reset();
  renderTabs();
  resizeTerminal();
  term.focus();
}

function resizeTerminal() {
    if (!activeSessionId) return;
    setTimeout(() => {
        term.fit(); // You might need the fit addon for this. Or manually calculate.
        socket.emit('resize', { sessionId: activeSessionId, cols: term.cols, rows: term.rows });
    }, 0);
}

// --- Socket Event Handlers ---
socket.on('sessions-list', (sessionList) => {
  sessions.clear();
  sessionList.forEach(s => sessions.set(s.id, s));
  
  if (sessions.size > 0 && !sessions.has(activeSessionId)) {
    const firstSessionId = sessions.keys().next().value;
    switchSession(firstSessionId);
  } else {
    renderTabs();
  }
});

socket.on('session-created', (session) => {
  sessions.set(session.id, session);
  renderTabs();
  switchSession(session.id); // Automatically switch to the new session
});

socket.on('session-closed', ({ id }) => {
  const wasActive = (id === activeSessionId);
  if (sessions.has(id)) {
    sessions.delete(id);
    
    if (wasActive && sessions.size > 0) {
      const nextSessionId = sessions.keys().next().value;
      switchSession(nextSessionId);
    } else if (sessions.size === 0) {
      activeSessionId = null;
      term.reset();
      term.write('\x1b[31mTất cả các phiên đã đóng. Hãy tạo một phiên mới.\x1b[0m\r\n');
      renderTabs();
    } else {
      renderTabs();
    }
  }
});

term.onData(data => {
  if (activeSessionId) {
    socket.emit('input', { sessionId: activeSessionId, data });
  }
});

socket.on('output', data => {
  term.write(data);
});

socket.on('history', history => {
  term.reset();
  term.write(history);
});

window.addEventListener('resize', resizeTerminal);

socket.on('connect', () => {
  console.log('🟢 Đã kết nối đến server');
  statusText.textContent = 'Đã kết nối';
  // On reconnection, if we have an active session, tell the server to resubscribe.
  // The server will respond with the session history.
  if (activeSessionId) {
    socket.emit('switch-session', activeSessionId);
  }
});

socket.on('disconnect', () => {
  console.log('🔴 Mất kết nối với server');
  statusText.textContent = 'Mất kết nối';
  term.write('\x1b[31m⚠️  Mất kết nối với server. Đang thử kết nối lại...\x1b[0m\r\n');
});

socket.on('connect_error', () => {
  statusText.textContent = 'Lỗi kết nối';
});

// Make terminal background transparent
window.addEventListener('load', () => {
  const termEl = document.querySelector('.xterm-viewport');
  if (termEl) {
    termEl.style.backgroundColor = 'transparent';
  }
});
