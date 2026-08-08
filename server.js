const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------- 単語辞書の読み込み ----------
const WORDS_PATH = path.join(__dirname, 'data', 'words.txt');

function loadWords() {
  const raw = fs.readFileSync(WORDS_PATH, 'utf8');
  const set = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const w = line.trim();
    if (!w || w.startsWith('#')) continue;
    set.add(w);
  }
  return set;
}

let WORD_SET = loadWords();
console.log(`辞書を読み込みました: ${WORD_SET.size} 語`);

// 背景演出用: 辞書の全単語をそのまま返す
app.get('/api/words', (req, res) => {
  res.json(Array.from(WORD_SET));
});

// ---------- かな正規化ユーティリティ ----------

// 全角カタカナ -> ひらがな
function katakanaToHiragana(str) {
  return str.replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function normalizeInput(str) {
  if (!str) return '';
  let s = str.normalize('NFKC'); // 半角カナ・全角英数などをまとめて正規化
  s = katakanaToHiragana(s);
  s = s.trim();
  return s;
}

const SMALL_TO_BIG = {
  ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お',
  ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', っ: 'つ',
};

function bigKana(ch) {
  return SMALL_TO_BIG[ch] || ch;
}

// 各かなの母音 (あ/い/う/え/お) を引く表
const VOWEL_ROWS = [
  'あいうえお',
  'かきくけこ', 'がぎぐげご',
  'さしすせそ', 'ざじずぜぞ',
  'たちつてと', 'だぢづでど',
  'なにぬねの',
  'はひふへほ', 'ばびぶべぼ', 'ぱぴぷぺぽ',
  'まみむめも',
  'らりるれろ',
];
const VOWELS = ['あ', 'い', 'う', 'え', 'お'];
const vowelOf = {};
for (const row of VOWEL_ROWS) {
  for (let i = 0; i < row.length; i++) vowelOf[row[i]] = VOWELS[i];
}
vowelOf['や'] = 'あ'; vowelOf['ゆ'] = 'う'; vowelOf['よ'] = 'お';
vowelOf['わ'] = 'あ'; vowelOf['を'] = 'お';
vowelOf['ぁ'] = 'あ'; vowelOf['ぃ'] = 'い'; vowelOf['ぅ'] = 'う';
vowelOf['ぇ'] = 'え'; vowelOf['ぉ'] = 'お';
vowelOf['ゃ'] = 'あ'; vowelOf['ゅ'] = 'う'; vowelOf['ょ'] = 'お';

// しりとりの「つながり判定」に使う最初の文字
function effectiveFirstChar(word) {
  const chars = Array.from(word);
  return bigKana(chars[0]);
}

// しりとりの「つながり判定」に使う最後の文字(長音・小さい文字を正規化)
function effectiveLastChar(word) {
  const chars = Array.from(word);
  let i = chars.length - 1;
  if (chars[i] === 'ー') {
    // 長音符の直前の文字の母音を使う
    let j = i - 1;
    while (j >= 0 && chars[j] === 'ー') j--;
    const base = j >= 0 ? chars[j] : null;
    const vowel = base ? vowelOf[bigKana(base)] : null;
    return vowel || chars[i];
  }
  return bigKana(chars[i]);
}

function endsWithN(word) {
  const chars = Array.from(word);
  return chars[chars.length - 1] === 'ん';
}

// ---------- ルーム管理 ----------

/**
 * room = {
 *   code, hostId, timeLimit,
 *   players: Map(socketId -> {id, name, alive, wordCount}),
 *   order: [socketId,...], turnIndex,
 *   state: 'lobby' | 'playing' | 'ended',
 *   usedWords: Set, lastWord, history: [{name, word}],
 *   timer: intervalId, deadline: number
 * }
 */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function publicRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    timeLimit: room.timeLimit,
    players: room.order
      .map((id) => room.players.get(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, alive: p.alive, wordCount: p.wordCount })),
    currentTurnId: room.state === 'playing' ? room.order[room.turnIndex] : null,
    lastWord: room.lastWord,
    history: room.history.slice(-50),
    deadline: room.deadline || null,
  };
}

function broadcastState(room) {
  io.to(room.code).emit('roomState', publicRoomState(room));
}

function aliveIds(room) {
  return room.order.filter((id) => room.players.get(id) && room.players.get(id).alive);
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function endGame(room, resultMessage) {
  room.state = 'ended';
  clearRoomTimer(room);
  room.deadline = null;
  io.to(room.code).emit('gameOver', { message: resultMessage });
  broadcastState(room);
}

function advanceTurn(room) {
  const alive = aliveIds(room);
  if (alive.length <= 1) {
    const winner = alive[0] ? room.players.get(alive[0]) : null;
    endGame(room, winner ? `${winner.name} の勝ち!🎉` : 'ゲーム終了');
    return;
  }
  // 次の生存プレイヤーへ
  let next = room.turnIndex;
  for (let i = 0; i < room.order.length; i++) {
    next = (next + 1) % room.order.length;
    const p = room.players.get(room.order[next]);
    if (p && p.alive) break;
  }
  room.turnIndex = next;
  startTurnTimer(room);
  broadcastState(room);
}

function startTurnTimer(room) {
  clearRoomTimer(room);
  if (!room.timeLimit) {
    room.deadline = null;
    return;
  }
  room.deadline = Date.now() + room.timeLimit * 1000;
  room.timer = setInterval(() => {
    if (room.state !== 'playing') {
      clearRoomTimer(room);
      return;
    }
    if (Date.now() >= room.deadline) {
      const currentId = room.order[room.turnIndex];
      const player = room.players.get(currentId);
      clearRoomTimer(room);
      if (player) {
        player.alive = false;
        room.history.push({ name: player.name, word: '(時間切れ)', system: true });
        io.to(room.code).emit('log', `⏰ ${player.name} は時間切れで脱落しました`);
      }
      advanceTurn(room);
    }
  }, 300);
}

function eliminatePlayer(room, playerId, reason) {
  const p = room.players.get(playerId);
  if (!p) return;
  p.alive = false;
  io.to(room.code).emit('log', `💥 ${p.name} は「${reason}」で脱落しました`);
}

function removePlayerFromRoom(socket, room) {
  const wasInGame = room.players.has(socket.id);
  room.players.delete(socket.id);
  room.order = room.order.filter((id) => id !== socket.id);
  socket.leave(room.code);

  if (room.players.size === 0) {
    clearRoomTimer(room);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.order[0];
  }

  if (room.state === 'playing' && wasInGame) {
    const wasCurrentTurn = room.order[room.turnIndex] === undefined
      ? false
      : false; // turnIndex now points elsewhere after splice; recompute below

    // ターン中のプレイヤーが抜けた場合はターンを進める
    if (room.turnIndex >= room.order.length) room.turnIndex = 0;
    const alive = aliveIds(room);
    if (alive.length <= 1) {
      const winner = alive[0] ? room.players.get(alive[0]) : null;
      endGame(room, winner ? `${winner.name} の勝ち!🎉` : 'ゲーム終了(全員退出)');
      return;
    }
  }
  broadcastState(room);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, timeLimit }) => {
    const cleanName = (name || '').toString().trim().slice(0, 16) || `プレイヤー${Math.floor(Math.random() * 1000)}`;
    const code = makeRoomCode();
    const room = {
      code,
      hostId: socket.id,
      timeLimit: Math.min(Math.max(parseInt(timeLimit, 10) || 20, 5), 120),
      players: new Map(),
      order: [],
      turnIndex: 0,
      state: 'lobby',
      usedWords: new Set(),
      lastWord: null,
      history: [],
      timer: null,
      deadline: null,
    };
    room.players.set(socket.id, { id: socket.id, name: cleanName, alive: true, wordCount: 0 });
    room.order.push(socket.id);
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('joined', { code, selfId: socket.id });
    broadcastState(room);
  });

  socket.on('joinRoom', ({ name, code }) => {
    const room = rooms.get((code || '').toString().trim().toUpperCase());
    if (!room) {
      socket.emit('errorMsg', 'その部屋コードは見つかりませんでした');
      return;
    }
    if (room.state === 'playing') {
      socket.emit('errorMsg', 'このゲームは進行中です。終了後に参加してください');
      return;
    }
    const cleanName = (name || '').toString().trim().slice(0, 16) || `プレイヤー${Math.floor(Math.random() * 1000)}`;
    room.players.set(socket.id, { id: socket.id, name: cleanName, alive: true, wordCount: 0 });
    room.order.push(socket.id);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('joined', { code: room.code, selfId: socket.id });
    io.to(room.code).emit('log', `👋 ${cleanName} が参加しました`);
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.order.length < 1) return;
    room.state = 'playing';
    room.usedWords = new Set();
    room.lastWord = null;
    room.history = [];
    room.turnIndex = 0;
    for (const p of room.players.values()) {
      p.alive = true;
      p.wordCount = 0;
    }
    io.to(room.code).emit('log', '🎮 ゲームを開始しました!');
    startTurnTimer(room);
    broadcastState(room);
  });

  socket.on('submitWord', (rawWord) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const currentId = room.order[room.turnIndex];
    if (currentId !== socket.id) {
      socket.emit('errorMsg', 'あなたの番ではありません');
      return;
    }

    const word = normalizeInput((rawWord || '').toString());
    if (!word) {
      socket.emit('errorMsg', '単語を入力してください');
      return;
    }
    if (!/^[ぁ-んー]+$/.test(word)) {
      socket.emit('errorMsg', 'ひらがな(またはカタカナ)で入力してください');
      return;
    }
    if (room.usedWords.has(word)) {
      socket.emit('errorMsg', 'その単語はすでに使われています');
      return;
    }
    if (!WORD_SET.has(word)) {
      socket.emit('errorMsg', '辞書に登録されていない単語です');
      return;
    }
    if (room.lastWord) {
      const need = effectiveLastChar(room.lastWord);
      const got = effectiveFirstChar(word);
      if (need !== got) {
        socket.emit('errorMsg', `「${need}」から始まる単語を入力してください`);
        return;
      }
    }

    // 単語を確定
    const player = room.players.get(socket.id);
    room.usedWords.add(word);
    room.lastWord = word;
    player.wordCount += 1;
    room.history.push({ name: player.name, word });
    io.to(room.code).emit('log', `✅ ${player.name}: ${word}`);

    if (endsWithN(word)) {
      eliminatePlayer(room, socket.id, `「ん」で終わる単語(${word})`);
      advanceTurn(room);
      return;
    }

    advanceTurn(room);
  });

  socket.on('leaveRoom', () => {
    const room = rooms.get(socket.data.roomCode);
    if (room) removePlayerFromRoom(socket, room);
    socket.data.roomCode = null;
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (room) removePlayerFromRoom(socket, room);
  });
});

server.listen(PORT, () => {
  console.log(`しりとりサーバー起動: http://localhost:${PORT}`);
});
