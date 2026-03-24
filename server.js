const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── 状态管理 ────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = 'admin123'; // 管理员密码

let state = {
  status: 'waiting',        // waiting | running | ended
  currentQuestionIndex: -1,
  questions: [
    {
      id: uuidv4(),
      title: '下列哪个是JavaScript的数据类型？',
      options: ['String', 'Integer', 'Float', 'Char'],
      correctAnswer: 0,
      score: 10
    },
    {
      id: uuidv4(),
      title: 'HTML的全称是什么？',
      options: [
        'HyperText Markup Language',
        'HighText Machine Language',
        'HyperText Machine Language',
        'HighText Markup Language'
      ],
      correctAnswer: 0,
      score: 10
    },
    {
      id: uuidv4(),
      title: 'CSS中用于设置文字颜色的属性是？',
      options: ['font-color', 'text-color', 'color', 'foreground'],
      correctAnswer: 2,
      score: 10
    }
  ]
};

// 玩家集合: { id, name, ws, score, answers: { questionIndex: answerIndex } }
const players = new Map();
// 管理员 WebSocket 集合
const admins = new Set();

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data, excludeWs = null) {
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function broadcastToAdmins(data) {
  admins.forEach(ws => send(ws, data));
}

function getPlayerCount() {
  return players.size;
}

function getRanking() {
  const list = Array.from(players.values())
    .map(p => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
  return list.map((p, i) => ({ ...p, rank: i + 1 }));
}

function getAnsweredCount(questionIndex) {
  let count = 0;
  players.forEach(p => {
    if (p.answers[questionIndex] !== undefined) count++;
  });
  return count;
}

function getSafeQuestion(q, index) {
  return {
    index,
    total: state.questions.length,
    id: q.id,
    title: q.title,
    options: q.options,
    score: q.score
    // correctAnswer 不发送给玩家
  };
}

// ─── WebSocket 连接处理 ────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let clientId = null;
  let clientRole = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'error', message: '消息格式错误' });
    }

    switch (msg.type) {

      // ── 玩家加入 ──
      case 'join_player': {
        const name = (msg.name || '').trim();
        if (!name) return send(ws, { type: 'error', message: '请输入昵称' });
        if (state.status === 'running') {
          return send(ws, { type: 'error', message: '答题已开始，无法加入' });
        }
        if (state.status === 'ended') {
          return send(ws, { type: 'error', message: '本次答题已结束' });
        }
        if (players.size >= 30) {
          return send(ws, { type: 'error', message: '房间已满（最多30人）' });
        }

        clientId = uuidv4();
        clientRole = 'player';
        players.set(clientId, { id: clientId, name, ws, score: 0, answers: {} });

        send(ws, { type: 'join_success', playerId: clientId, name, playerCount: getPlayerCount() });

        // 广播玩家数量更新
        broadcast({ type: 'player_count', count: getPlayerCount() });
        broadcastToAdmins({ type: 'player_list', players: getRanking(), count: getPlayerCount() });
        break;
      }

      // ── 管理员登录 ──
      case 'join_admin': {
        if (msg.password !== ADMIN_PASSWORD) {
          return send(ws, { type: 'error', message: '管理员密码错误' });
        }
        clientRole = 'admin';
        admins.add(ws);
        send(ws, {
          type: 'admin_joined',
          questions: state.questions,
          status: state.status,
          playerCount: getPlayerCount(),
          players: getRanking(),
          currentQuestionIndex: state.currentQuestionIndex
        });
        break;
      }

      // ── 保存题目 ──
      case 'save_questions': {
        if (clientRole !== 'admin') return send(ws, { type: 'error', message: '无权限' });
        if (state.status === 'running') {
          return send(ws, { type: 'error', message: '答题进行中，无法修改题目' });
        }
        const qs = msg.questions;
        if (!Array.isArray(qs) || qs.length === 0) {
          return send(ws, { type: 'error', message: '题目不能为空' });
        }
        state.questions = qs.map(q => ({
          id: q.id || uuidv4(),
          title: q.title,
          options: q.options,
          correctAnswer: q.correctAnswer,
          score: q.score || 10
        }));
        send(ws, { type: 'save_success', questions: state.questions });
        break;
      }

      // ── 开始答题 ──
      case 'start_quiz': {
        if (clientRole !== 'admin') return send(ws, { type: 'error', message: '无权限' });
        if (state.status === 'running') return send(ws, { type: 'error', message: '已在进行中' });
        if (state.questions.length === 0) return send(ws, { type: 'error', message: '请先设置题目' });
        if (players.size === 0) return send(ws, { type: 'error', message: '暂无玩家加入' });

        // 重置玩家分数
        players.forEach(p => { p.score = 0; p.answers = {}; });

        state.status = 'running';
        state.currentQuestionIndex = -1;

        broadcast({ type: 'quiz_started', totalQuestions: state.questions.length });
        send(ws, { type: 'quiz_started', totalQuestions: state.questions.length });
        break;
      }

      // ── 下一题 ──
      case 'next_question': {
        if (clientRole !== 'admin') return send(ws, { type: 'error', message: '无权限' });
        if (state.status !== 'running') return send(ws, { type: 'error', message: '答题未开始' });

        state.currentQuestionIndex++;
        if (state.currentQuestionIndex >= state.questions.length) {
          return send(ws, { type: 'error', message: '已经是最后一题，请结束答题' });
        }

        const q = state.questions[state.currentQuestionIndex];
        const questionData = getSafeQuestion(q, state.currentQuestionIndex);

        broadcast({ type: 'question', ...questionData });
        send(ws, { type: 'question', ...questionData, correctAnswer: q.correctAnswer });
        broadcastToAdmins({
          type: 'question_status',
          questionIndex: state.currentQuestionIndex,
          answeredCount: 0,
          playerCount: getPlayerCount()
        });
        break;
      }

      // ── 玩家提交答案 ──
      case 'submit_answer': {
        if (clientRole !== 'player') return;
        if (state.status !== 'running') return;
        const player = players.get(clientId);
        if (!player) return;

        const qi = state.currentQuestionIndex;
        if (player.answers[qi] !== undefined) {
          return send(ws, { type: 'error', message: '已提交过答案' });
        }
        if (qi < 0 || qi >= state.questions.length) return;

        const answerIndex = msg.answer;
        const correct = state.questions[qi].correctAnswer;
        const isCorrect = answerIndex === correct;
        const earned = isCorrect ? state.questions[qi].score : 0;

        player.answers[qi] = answerIndex;
        player.score += earned;

        send(ws, {
          type: 'answer_result',
          isCorrect,
          correctAnswer: correct,
          earned,
          totalScore: player.score
        });

        const answered = getAnsweredCount(qi);
        broadcastToAdmins({
          type: 'question_status',
          questionIndex: qi,
          answeredCount: answered,
          playerCount: getPlayerCount()
        });
        break;
      }

      // ── 结束答题 ──
      case 'end_quiz': {
        if (clientRole !== 'admin') return send(ws, { type: 'error', message: '无权限' });
        if (state.status !== 'running') return send(ws, { type: 'error', message: '答题未开始' });

        state.status = 'ended';
        const ranking = getRanking();

        broadcast({ type: 'quiz_ended', ranking });
        send(ws, { type: 'quiz_ended', ranking });
        break;
      }

      // ── 重置答题 ──
      case 'reset_quiz': {
        if (clientRole !== 'admin') return send(ws, { type: 'error', message: '无权限' });

        state.status = 'waiting';
        state.currentQuestionIndex = -1;
        players.forEach(p => { p.score = 0; p.answers = {}; });

        broadcast({ type: 'quiz_reset' });
        send(ws, { type: 'reset_success', playerCount: getPlayerCount() });
        break;
      }

      default:
        send(ws, { type: 'error', message: '未知消息类型' });
    }
  });

  ws.on('close', () => {
    if (clientRole === 'player' && clientId) {
      players.delete(clientId);
      broadcast({ type: 'player_count', count: getPlayerCount() });
      broadcastToAdmins({ type: 'player_list', players: getRanking(), count: getPlayerCount() });
    } else if (clientRole === 'admin') {
      admins.delete(ws);
    }
  });

  ws.on('error', () => {
    if (clientRole === 'player' && clientId) players.delete(clientId);
    if (clientRole === 'admin') admins.delete(ws);
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, players: getPlayerCount(), status: state.status }));

app.get('/api/questions', (req, res) => res.json(state.questions));

// ─── 启动 ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ 答题服务器运行在 http://localhost:${PORT}`);
  console.log(`📡 WebSocket 地址: ws://localhost:${PORT}`);
  console.log(`🔑 管理员密码: ${ADMIN_PASSWORD}`);
});
