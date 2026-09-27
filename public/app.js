// public/app.js

// import { stat } from "node:fs";

const $ = (id) => document.getElementById(id);

let roomCode = localStorage.getItem('sg_room') || '';
let playerId = localStorage.getItem('sg_player') || '';
let playerName = '';

let state = null;
let stream = null;
let toastTimer = null;
let roundDeadline = 0;

let drawing = false;
let currentPoints = [];
let erase = false;
let brushColor = '#092829';
let brushType = 'normal';
const brushIcons = { normal: '<i class="ri-brush-line"></i>', spray: '<i class="ri-paint-line"></i>', marker: '<i class="ri-markup-line"></i>' };
const brushTypes = Object.keys(brushIcons);

let canvas = null;
let ctx = null;

function show(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(view).classList.add('active');

  // The canvas can have zero dimensions while gameView is hidden.
  // Resize it after the view becomes visible.
  if (view === 'gameView') {
    requestAnimationFrame(() => {
      sizeCanvas();
      drawAll();
    });
  }
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function setError(id, msg) {
  $(id).textContent = msg || '';
}

async function api(path, options = {}) {
  const r = await fetch(path, {
    headers: {
      'content-type': 'application/json'
    },
    ...options
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function saveSession() {
  localStorage.setItem('sg_room', roomCode);
  localStorage.setItem('sg_player', playerId);
}

function renderLobby() {
  $('lobbyRoomCode').textContent = roomCode;
  $('bigRoomCode').textContent = roomCode;
  $('playerCount').textContent = `${state.players.length} / 8`;

  $('lobbyPlayers').innerHTML = state.players
    .map((p, i) => `
      <div class="player-row">
        <span class="player-name">
          ${i === 0 ? '★ ' : ''}
          ${escapeHtml(p.name)}
          ${p.id === playerId ? '<span class="player-you">YOU</span>' : ''}
        </span>
        <span class="muted">
          ${p.connected ? '● online' : '○ away'}
        </span>
      </div>
    `)
    .join('');

  const isHost = state.hostId === playerId;
  $('startBtn').disabled = !isHost || state.players.length < 2;
  $('startBtn').textContent = isHost ? 'Start Game' : 'Waiting for host...';
}

function renderGame() {
  roundDeadline = Date.now() + (state.timeLeftMs || 0);

  $('roundLabel').textContent =
    `ROUND ${state.round} / ${state.totalRounds}`;

  $('gameRoomCode').textContent = roomCode;

  const me = state.players.find(p => p.id === playerId);

  const drawingNow =
    state.drawerId === playerId &&
    state.gameStatus === 'playing';

  const drawer =
    state.players.find(p => p.id === state.drawerId);

  $('turnText').textContent = drawingNow
    ? 'Your turn to draw'
    : `${escapeHtml(drawer?.name || 'Someone')} is drawing`;

  $('wordReveal').textContent = drawingNow
    ? `WORD: ${String(state.secretWord || '').toUpperCase()}`
    : '';

  $('drawTools').style.display =
    drawingNow ? 'flex' : 'none';

  $('guessForm').style.display =
    !drawingNow && state.gameStatus === 'playing'
      ? 'grid'
      : 'none';

  $('guessStatus').textContent = !drawingNow
    ? `${me?.hasGuessed ? 'Correct ✓' : 'Guess the drawing'}`
    : 'You are the drawer';

  $('canvasOverlay').classList.toggle(
    'show',
    state.gameStatus === 'round_end'
  );

  $('sideScores').innerHTML =
    state.leaderboard
      .map((p, i) => `
        <div class="score-row">
          <span class="score-rank">0${i + 1}</span>
          <span class="score-name">${escapeHtml(p.name)}</span>
          <span class="score-points">${p.score}</span>
        </div>
      `)
      .join('');

  $('gamePlayers').innerHTML =
    state.players
      .map(p => `
        <span class="mini-chip ${p.connected ? '' : 'off'}">
          ${escapeHtml(p.name)}
        </span>
      `)
      .join('');

  const feed = state.guesses || [];

  $('guessFeed').innerHTML =
    feed
      .map(g => `
        <div class="guess-item ${g.correct ? 'correct' : ''}">
          <span class="who">${escapeHtml(g.playerName)}</span>
          ${g.correct
            ? '✓ found it!'
            : escapeHtml(g.guess)}
        </div>
      `)
      .join('');

  $('guessFeed').scrollTop =
    $('guessFeed').scrollHeight;

  if (drawingNow) {
    $('canvasOverlay').classList.remove('show');
    $('guessInput').disabled = true;
  } else {
    $('guessInput').disabled = !!me?.hasGuessed;

    if (me?.hasGuessed) {
      $('guessMessage').textContent =
        'Nice! You found it.';
    }
  }

  // IMPORTANT:
  // gameView was previously hidden, so the canvas could have
  // been initialized with width/height = 0.
  requestAnimationFrame(() => {
    sizeCanvas();
    drawAll();
  });
}

function renderEnd() {
  show('endView');

  const winner = state.winner;

  $('winnerTitle').textContent =
    winner
      ? `🏆 ${winner.name} wins!`
      : '🏆 Final scores';

  $('winnerSub').textContent = 'Final leaderboard';

  $('finalScores').innerHTML =
    state.leaderboard
      .map((p, i) => `
        <div class="final-row">
          <b>${i + 1}. ${escapeHtml(p.name)}</b>
          <span>${p.score} pts</span>
        </div>
      `)
      .join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>'"]/g,
    c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[c])
  );
}

function openStream() {
  if (stream) {
    stream.close();
  }

  stream = new EventSource(
    `/api/stream?roomCode=${encodeURIComponent(roomCode)}&playerId=${encodeURIComponent(playerId)}`
  );

  stream.addEventListener('state', e => {
    state = JSON.parse(e.data);

    if (state.gameStatus === 'lobby') {
      show('lobbyView');
      renderLobby();
    } else if (state.gameStatus === 'finished') {
      renderEnd();
    } else {
      show('gameView');
      renderGame();
    }
  });

  stream.onerror = () => {};
}

async function createRoom() {
  setError('homeError', '');

  playerName =
    $('homeName').value.trim() || 'Player';

  try {
    const d = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name: playerName
      })
    });

    roomCode = d.roomCode;
    playerId = d.playerId;
    state = d.state;

    saveSession();
    openStream();

    show('lobbyView');
    renderLobby();
  } catch (e) {
    setError('homeError', e.message);
  }
}

async function joinRoom() {
  setError('homeError', '');

  playerName =
    $('homeName').value.trim() || 'Player';

  roomCode =
    $('joinCode').value.trim().toUpperCase();

  if (roomCode.length < 5) {
    setError(
      'homeError',
      'Enter the 5-character room code.'
    );
    return;
  }

  try {
    const d = await api('/api/join', {
      method: 'POST',
      body: JSON.stringify({
        roomCode,
        name: playerName,
        playerId: playerId || undefined
      })
    });

    playerId = d.playerId;
    saveSession();

    state = d.state;
    openStream();

    if (state.gameStatus === 'lobby') {
      show('lobbyView');
      renderLobby();
    } else {
      show('gameView');
      renderGame();
    }
  } catch (e) {
    setError('homeError', e.message);
  }
}

async function startGame() {
  setError('lobbyError', '');

  try {
    await api(`/api/rooms/${roomCode}/start`, {
      method: 'POST',
      body: JSON.stringify({
        playerId
      })
    });
  } catch (e) {
    setError('lobbyError', e.message);
  }
}

async function sendGuess(e) {
  e.preventDefault();

  const input = $('guessInput');
  const guess = input.value.trim();

  if (!guess) return;

  input.value = '';

  try {
    const d = await api(
      `/api/rooms/${roomCode}/guess`,
      {
        method: 'POST',
        body: JSON.stringify({
          playerId,
          guess
        })
      }
    );

    $('guessMessage').textContent =
      d.correct
        ? '🎉 Correct!'
        : 'Not quite — keep going.';

    if (d.correct) {
      input.disabled = true;
    }
  } catch (e) {
    $('guessMessage').textContent = e.message;
  }
}

async function stroke(points) {
  try {
    await api(
      `/api/rooms/${roomCode}/stroke`,
      {
        method: 'POST',
        body: JSON.stringify({
          playerId,
          stroke: {
            points,
            size: Number($('brushSize').value),
            erase,
            color: brushColor,
            brush: brushType
          }
        })
      }
    );
  } catch (e) {
    toast(e.message);
  }
}

async function clearCanvas() {
  try {
    await api(
      `/api/rooms/${roomCode}/clear`,
      {
        method: 'POST',
        body: JSON.stringify({
          playerId
        })
      }
    );
  } catch (e) {
    toast(e.message);
  }
}

async function playAgain() {
  try {
    await api(
      `/api/rooms/${roomCode}/play-again`,
      {
        method: 'POST',
        body: JSON.stringify({
          playerId
        })
      }
    );

    show('lobbyView');
  } catch (e) {
    toast(e.message);
  }
}

/*
 * Canvas handling
 *
 * The original bug was caused by initializing the canvas while
 * gameView was display:none. That gives getBoundingClientRect()
 * a 0x0 size and therefore creates a 0x0 drawing buffer.
 *
 * This version always synchronizes the backing canvas size with
 * the visible CSS size.
 */
function sizeCanvas() {
  if (!canvas || !ctx) return;

  const rect = canvas.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  const dpr = Math.max(1, window.devicePixelRatio || 1);

  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);

  if (
    canvas.width !== width ||
    canvas.height !== height
  ) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );
}

function drawAll() {
  if (!canvas || !ctx) return;

  const rect = canvas.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  ctx.clearRect(
    0,
    0,
    rect.width,
    rect.height
  );

  ctx.fillStyle = '#ffffff';

  ctx.fillRect(
    0,
    0,
    rect.width,
    rect.height
  );

  for (const s of state?.strokes || []) {
    drawStroke(s, rect);
  }
}

function drawStroke(s, rect) {
  if (!s?.points?.length) return;

  ctx.save();

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Number(s.size) || 5;

  let color = s.erase ? '#ffffff' : (s.color || '#092829');
  let bType = s.erase ? 'normal' : (s.brush || 'normal');

  if (bType === 'spray') {
    ctx.shadowBlur = ctx.lineWidth * 2;
    ctx.shadowColor = color;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
  } else if (bType === 'marker') {
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
  } else {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
  }

  ctx.beginPath();

  s.points.forEach((pt, i) => {
    const x = pt[0] * rect.width;
    const y = pt[1] * rect.height;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  // For a single-point tap, draw a small dot.
  if (s.points.length === 1) {
    const x = s.points[0][0] * rect.width;
    const y = s.points[0][1] * rect.height;

    ctx.beginPath();
    ctx.arc(
      x,
      y,
      Math.max(1, (Number(s.size) || 5) / 2),
      0,
      Math.PI * 2
    );
    ctx.fill();
  } else {
    ctx.stroke();
  }

  ctx.restore();
}

function pointerPos(e) {
  const r = canvas.getBoundingClientRect();

  if (
    r.width <= 0 ||
    r.height <= 0
  ) {
    return [0, 0];
  }

  return [
    Math.max(
      0,
      Math.min(
        1,
        (e.clientX - r.left) / r.width
      )
    ),
    Math.max(
      0,
      Math.min(
        1,
        (e.clientY - r.top) / r.height
      )
    )
  ];
}

function beginDraw(e) {
  if (
    state?.drawerId !== playerId ||
    state.gameStatus !== 'playing'
  ) {
    return;
  }

  e.preventDefault();

  drawing = true;
  currentPoints = [pointerPos(e)];

  if (canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
  }

  drawPreview();
}

function moveDraw(e) {
  if (!drawing) return;

  e.preventDefault();

  currentPoints.push(pointerPos(e));
  drawPreview();
}

function endDraw(e) {
  if (!drawing) return;

  if (e) {
    e.preventDefault();
  }

  drawing = false;

  if (
    canvas.releasePointerCapture &&
    e?.pointerId != null
  ) {
    try {
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    } catch {}
  }

  if (currentPoints.length > 0) {
    const points = currentPoints.slice();

    // Keep the local preview visible immediately.
    drawPreview();

    // Send the completed stroke to the server.
    stroke(points);
  }

  currentPoints = [];
}

function drawPreview() {
  drawAll();

  if (!currentPoints.length) {
    return;
  }

  const rect = canvas.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  ctx.save();

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth =
    Number($('brushSize').value) || 5;

  let color = erase ? '#ffffff' : brushColor;
  let bType = erase ? 'normal' : brushType;

  if (bType === 'spray') {
    ctx.shadowBlur = ctx.lineWidth * 2;
    ctx.shadowColor = color;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
  } else if (bType === 'marker') {
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
  } else {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
  }

  ctx.beginPath();

  currentPoints.forEach((pt, i) => {
    const x = pt[0] * rect.width;
    const y = pt[1] * rect.height;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  if (currentPoints.length === 1) {
    const x = currentPoints[0][0] * rect.width;
    const y = currentPoints[0][1] * rect.height;

    ctx.beginPath();
    ctx.arc(
      x,
      y,
      Math.max(
        1,
        (Number($('brushSize').value) || 5) / 2
      ),
      0,
      Math.PI * 2
    );
    ctx.fill();
  } else {
    ctx.stroke();
  }

  ctx.restore();
}

/* Controls */

$('createBtn').onclick = createRoom;
$('joinBtn').onclick = joinRoom;
$('startBtn').onclick = startGame;
$('guessForm').onsubmit = sendGuess;
$('clearBtn').onclick = clearCanvas;

$('undoBtn').onclick = async () => {
  try {
    await api(`/api/rooms/${roomCode}/undo`, {
      method: 'POST',
      body: JSON.stringify({ playerId })
    });
  } catch (e) { toast(e.message); }
};

$('brushTypeBtn').onclick = () => {
  let idx = brushTypes.indexOf(brushType);
  idx = (idx + 1) % brushTypes.length;
  brushType = brushTypes[idx];
  $('brushTypeBtn').innerHTML = brushIcons[brushType];
};

$('brushColor').oninput = (e) => {
  brushColor = e.target.value;
  erase = false;
  $('eraserBtn').classList.remove('active');
};

$('eraserBtn').onclick = () => {
  erase = !erase;
  $('eraserBtn').classList.toggle(
    'active',
    erase
  );
};

$('playAgainBtn').onclick = playAgain;

$('homeBtn').onclick = () => {
  if (stream) {
    stream.close();
  }

  localStorage.removeItem('sg_room');
  localStorage.removeItem('sg_player');
  localStorage.removeItem('sg_name');

  roomCode = '';
  playerId = '';

  show('homeView');
};

$('copyBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    $('copyStatus').textContent = 'Copied!';
  } catch {
    $('copyStatus').textContent = 'Copy failed';
  }
};

$('copyGameCode').onclick = () => {
  navigator.clipboard
    ?.writeText(roomCode)
    .then(() => toast('Room code copied'));
};

$('joinCode').addEventListener(
  'input',
  e => {
    e.target.value =
      e.target.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
  }
);

$('homeName').value = playerName;

/* Canvas setup */

canvas = $('drawCanvas');

ctx = canvas.getContext('2d', {
  alpha: false,
  desynchronized: true
});

canvas.addEventListener(
  'pointerdown',
  beginDraw,
  { passive: false }
);

canvas.addEventListener(
  'pointermove',
  moveDraw,
  { passive: false }
);

canvas.addEventListener(
  'pointerup',
  endDraw,
  { passive: false }
);

canvas.addEventListener(
  'pointercancel',
  endDraw,
  { passive: false }
);

canvas.addEventListener(
  'pointerleave',
  e => {
    if (drawing) {
      moveDraw(e);
    }
  },
  { passive: false }
);

window.addEventListener(
  'resize',
  () => {
    requestAnimationFrame(() => {
      sizeCanvas();
      drawAll();
    });
  }
);

/*
 * Also resize after orientation changes on phones.
 */
window.addEventListener(
  'orientationchange',
  () => {
    setTimeout(() => {
      sizeCanvas();
      drawAll();
    }, 100);
  }
);

/* Timer */

setInterval(() => {
  if (state?.gameStatus === 'playing') {
    const ms = Math.max(
      0,
      roundDeadline - Date.now()
    );

    $('timerLabel').textContent =
      Math.ceil(ms / 1000);
  }
}, 250);

/* Boot */

async function boot() {
  // Don't initialize the canvas dimensions here because
  // gameView is hidden at startup.
  if (roomCode && playerId) {
    try {
      const d = await api('/api/join', {
        method: 'POST',
        body: JSON.stringify({
          roomCode,
          name: playerName,
          playerId
        })
      });

      state = d.state;

      openStream();

      if (state.gameStatus === 'lobby') {
        show('lobbyView');
        renderLobby();
      } else if (
        state.gameStatus === 'finished'
      ) {
        renderEnd();
      } else {
        show('gameView');
        renderGame();
      }

      return;
    } catch {
      localStorage.removeItem('sg_room');
      localStorage.removeItem('sg_player');

      roomCode = '';
      playerId = '';
    }
  }

  show('homeView');
}

boot();