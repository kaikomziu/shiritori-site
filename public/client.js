const socket = io();

let selfId = null;
let currentState = null;

// ---------- 背景に辞書の単語を敷き詰める / デバッグ検索用に保持 ----------
// 辞書は数万語規模になり得るため、背景表示は描画負荷を抑えるためサンプリングする
// (検索・つながり判定チェックなど機能面では ALL_WORDS に辞書全体が入る)
const WORD_BG_MAX = 4000;
let ALL_WORDS = [];
fetch('/api/words')
  .then((r) => r.json())
  .then((words) => {
    ALL_WORDS = words;
    // 表示のたびに並びが変わるようシャッフル(コピーを使う。ALL_WORDSは検索用に元の順のまま)
    const shuffled = words.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const sample = shuffled.slice(0, WORD_BG_MAX);
    const bg = document.getElementById('word-bg');
    if (!bg) return;
    const frag = document.createDocumentFragment();
    for (const w of sample) {
      const span = document.createElement('span');
      span.textContent = w;
      frag.appendChild(span);
    }
    bg.appendChild(frag);
  })
  .catch(() => {});

// ---------- 画面切り替え ----------
const screens = {
  home: document.getElementById('screen-home'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
  result: document.getElementById('screen-result'),
  debug: document.getElementById('screen-debug'),
};
function showScreen(name) {
  for (const key in screens) screens[key].classList.toggle('hidden', key !== name);
}

// ---------- ホーム画面 ----------
const inputName = document.getElementById('input-name');
const tabCreate = document.getElementById('tab-create');
const tabJoin = document.getElementById('tab-join');
const paneCreate = document.getElementById('pane-create');
const paneJoin = document.getElementById('pane-join');
const homeError = document.getElementById('home-error');

tabCreate.onclick = () => {
  tabCreate.classList.add('active');
  tabJoin.classList.remove('active');
  paneCreate.classList.remove('hidden');
  paneJoin.classList.add('hidden');
};
tabJoin.onclick = () => {
  tabJoin.classList.add('active');
  tabCreate.classList.remove('active');
  paneJoin.classList.remove('hidden');
  paneCreate.classList.add('hidden');
};

document.getElementById('btn-create').onclick = () => {
  homeError.textContent = '';
  const name = inputName.value.trim();
  const timeLimit = document.getElementById('input-timelimit').value;
  socket.emit('createRoom', { name, timeLimit });
};

document.getElementById('btn-join').onclick = () => {
  homeError.textContent = '';
  const name = inputName.value.trim();
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!code) { homeError.textContent = '部屋コードを入力してください'; return; }
  socket.emit('joinRoom', { name, code });
};

// ---------- デバッグ: 単語検索モード(合言葉: karwak) ----------
const DEBUG_PASSWORD = 'karwak';
const debugLink = document.getElementById('debug-link');
const debugGate = document.getElementById('debug-gate');
const debugPassword = document.getElementById('debug-password');
const debugGateError = document.getElementById('debug-gate-error');

debugLink.onclick = () => {
  debugGate.classList.toggle('hidden');
  if (!debugGate.classList.contains('hidden')) debugPassword.focus();
};

function tryUnlockDebug() {
  debugGateError.textContent = '';
  if (debugPassword.value === DEBUG_PASSWORD) {
    debugPassword.value = '';
    debugGate.classList.add('hidden');
    showScreen('debug');
    document.getElementById('debug-total').textContent = `辞書: ${ALL_WORDS.length} 語`;
    document.getElementById('debug-search').value = '';
    document.getElementById('debug-results').innerHTML = '';
    document.getElementById('debug-count').textContent = '';
  } else {
    debugGateError.textContent = '合言葉が違います';
  }
}
document.getElementById('debug-unlock').onclick = tryUnlockDebug;
debugPassword.onkeydown = (e) => { if (e.key === 'Enter') tryUnlockDebug(); };

document.getElementById('btn-debug-back').onclick = () => showScreen('home');

const debugSearchInput = document.getElementById('debug-search');
const debugResultsList = document.getElementById('debug-results');
const debugCountEl = document.getElementById('debug-count');
debugSearchInput.oninput = () => {
  const q = debugSearchInput.value.trim();
  debugResultsList.innerHTML = '';
  if (!q) { debugCountEl.textContent = ''; return; }
  const matches = ALL_WORDS.filter((w) => w.includes(q));
  debugCountEl.textContent = `${matches.length} 件ヒット(先頭100件を表示)`;
  const frag = document.createDocumentFragment();
  for (const w of matches.slice(0, 100)) {
    const li = document.createElement('li');
    li.textContent = w;
    frag.appendChild(li);
  }
  debugResultsList.appendChild(frag);
};

const debugCheckInput = document.getElementById('debug-check-word');
const debugCheckResult = document.getElementById('debug-check-result');
debugCheckInput.onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  const w = debugCheckInput.value.trim();
  if (!w) return;
  debugCheckResult.textContent = '確認中…';
  fetch('/api/debug/check?word=' + encodeURIComponent(w))
    .then((r) => r.json())
    .then((data) => {
      if (data.error) { debugCheckResult.textContent = data.error; return; }
      debugCheckResult.textContent =
        `正規化後: ${data.word}\n` +
        `ひらがなとして有効: ${data.validChars ? 'はい' : 'いいえ'}\n` +
        `辞書に登録: ${data.inDictionary ? '✅ あり' : '❌ なし'}\n` +
        `実効・最初の文字: ${data.effectiveFirst ?? '-'}\n` +
        `実効・最後の文字: ${data.effectiveLast ?? '-'}\n` +
        `「ん」で終わる: ${data.endsWithN ? 'はい(脱落ワード)' : 'いいえ'}`;
    })
    .catch(() => { debugCheckResult.textContent = '通信エラー'; });
};

// ---------- ロビー画面 ----------
document.getElementById('btn-start').onclick = () => {
  socket.emit('startGame');
};
document.getElementById('btn-leave-lobby').onclick = leaveRoom;
document.getElementById('btn-leave-game').onclick = leaveRoom;
document.getElementById('btn-leave-result').onclick = leaveRoom;
document.getElementById('btn-restart').onclick = () => {
  socket.emit('startGame');
};

function leaveRoom() {
  socket.emit('leaveRoom');
  showScreen('home');
}

// ---------- ゲーム画面 ----------
const formWord = document.getElementById('form-word');
const inputWord = document.getElementById('input-word');
const gameError = document.getElementById('game-error');

formWord.onsubmit = (e) => {
  e.preventDefault();
  const w = inputWord.value.trim();
  if (!w) return;
  socket.emit('submitWord', w);
  inputWord.value = '';
};

// ---------- ソケットイベント ----------
socket.on('joined', ({ code, selfId: id }) => {
  selfId = id;
  document.getElementById('lobby-code').textContent = code;
});

socket.on('errorMsg', (msg) => {
  if (!screens.home.classList.contains('hidden')) {
    homeError.textContent = msg;
  } else {
    gameError.textContent = msg;
    setTimeout(() => { gameError.textContent = ''; }, 2500);
  }
});

socket.on('log', (msg) => {
  // 履歴には roomState 側で反映されるのでここでは軽い演出のみ
});

let timerRAF = null;

socket.on('roomState', (state) => {
  currentState = state;
  renderPlayers(state);

  if (state.state === 'lobby') {
    showScreen('lobby');
    const isHost = state.hostId === selfId;
    document.getElementById('btn-start').classList.toggle('hidden', !isHost);
    document.getElementById('lobby-wait').classList.toggle('hidden', isHost);
  } else if (state.state === 'playing') {
    showScreen('game');
    renderGame(state);
  } else if (state.state === 'ended') {
    // gameOver イベントで画面遷移する
    renderResult(state);
  }
});

socket.on('gameOver', ({ message }) => {
  document.getElementById('result-message').textContent = message;
  const isHost = currentState && currentState.hostId === selfId;
  document.getElementById('btn-restart').classList.toggle('hidden', !isHost);
  showScreen('result');
});

function renderPlayers(state) {
  const lists = [document.getElementById('lobby-players'), document.getElementById('players-panel'), document.getElementById('result-players')];
  for (const list of lists) {
    if (!list) continue;
    list.innerHTML = '';
    for (const p of state.players) {
      const li = document.createElement('li');
      if (!p.alive) li.classList.add('dead');
      if (state.currentTurnId === p.id) li.classList.add('turn');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = (p.id === state.hostId ? '👑 ' : '') + p.name + (p.id === selfId ? ' (あなた)' : '');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `${p.wordCount}語`;
      li.appendChild(nameSpan);
      li.appendChild(badge);
      list.appendChild(li);
    }
  }
}

function renderGame(state) {
  const lastWordEl = document.getElementById('last-word');
  lastWordEl.textContent = state.lastWord ? state.lastWord : 'さいしょの単語をどうぞ';

  const historyList = document.getElementById('history-list');
  historyList.innerHTML = '';
  for (const h of state.history) {
    const li = document.createElement('li');
    if (h.system) li.classList.add('system');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = h.name + ':';
    li.appendChild(who);
    li.appendChild(document.createTextNode(h.word));
    historyList.appendChild(li);
  }
  historyList.scrollTop = historyList.scrollHeight;

  const isMyTurn = state.currentTurnId === selfId;
  const banner = document.getElementById('turn-banner');
  if (isMyTurn) {
    banner.textContent = '🟢 あなたの番です!';
  } else {
    const p = state.players.find((p) => p.id === state.currentTurnId);
    banner.textContent = p ? `⏳ ${p.name} の番です` : '';
  }
  inputWord.disabled = !isMyTurn;
  formWord.querySelector('button').disabled = !isMyTurn;
  if (isMyTurn) inputWord.focus();

  updateTimerBar(state.deadline);
}

function updateTimerBar(deadline) {
  cancelAnimationFrame(timerRAF);
  const bar = document.getElementById('timer-bar');
  if (!deadline) {
    bar.style.width = '100%';
    bar.style.background = '#2fbf71';
    return;
  }
  function tick() {
    const remain = deadline - Date.now();
    const total = currentState.timeLimit * 1000;
    const pct = Math.max(0, Math.min(100, (remain / total) * 100));
    bar.style.width = pct + '%';
    bar.style.background = pct < 25 ? '#e0435c' : (pct < 50 ? '#f5a524' : '#2fbf71');
    if (remain > 0) {
      timerRAF = requestAnimationFrame(tick);
    }
  }
  tick();
}

function renderResult(state) {
  // players list is rendered by renderPlayers already
}
