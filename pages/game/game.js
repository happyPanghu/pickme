// pages/game/game.js
// Chwazi 仿制：多指触摸随机选出赢家

const COUNTDOWN_MS = 3000;          // 连续 3 秒后定胜负
const FINGER_RADIUS = 70;           // 手指圆的目标半径（px）
const SPAWN_DURATION = 220;         // 圆圈从小到大的出现动画时长（ms）
const DESPAWN_DURATION = 180;       // 手指离开时缩小动画时长（ms）
const BREATH_AMPLITUDE = 8;         // 呼吸幅度（px）
const BREATH_PERIOD = 1100;         // 呼吸周期（ms）
const FLOOD_DURATION = 700;         // 胜者铺满屏幕动画时长（ms）

// HSL 随机色，保证饱和度亮度，视觉上明亮好看
function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 85%, 58%)`;
}

Page({
  data: {
    winnerCount: 1,
    touchCount: 0,
    countingDown: false,
    countdownText: '',
    flooding: false,
    floodColor: '#000000'
  },

  // ---- 非响应式运行时状态（不放 data，避免 setData 抖动） ----
  fingers: new Map(),   // identifier -> finger 对象
  winners: new Set(),   // 赢家 identifier 集合
  countdownTimer: null,
  rafId: null,
  canvas: null,
  ctx: null,
  dpr: 1,
  canvasWidth: 0,
  canvasHeight: 0,
  floodStartAt: 0,
  gameEnded: false,

  onLoad() {
    this.initCanvas();
  },

  onUnload() {
    this.stopLoop();
    this.clearCountdown();
  },

  // ---------------- Canvas 初始化 ----------------
  initCanvas() {
    const query = wx.createSelectorQuery();
    query.select('#gameCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          console.error('canvas node not found');
          return;
        }
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : (wx.getSystemInfoSync().pixelRatio || 1);

        canvas.width = res[0].width * dpr;
        canvas.height = res[0].height * dpr;
        ctx.scale(dpr, dpr);

        this.canvas = canvas;
        this.ctx = ctx;
        this.dpr = dpr;
        this.canvasWidth = res[0].width;
        this.canvasHeight = res[0].height;

        this.startLoop();
      });
  },

  // ---------------- 主循环 ----------------
  startLoop() {
    if (!this.canvas) return;
    const tick = () => {
      this.render();
      this.rafId = this.canvas.requestAnimationFrame(tick);
    };
    this.rafId = this.canvas.requestAnimationFrame(tick);
  },

  stopLoop() {
    if (this.canvas && this.rafId) {
      this.canvas.cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  },

  // ---------------- 渲染 ----------------
  render() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = Date.now();
    const w = this.canvasWidth;
    const h = this.canvasHeight;

    // 清屏（透明，背景由 wxss 的 stage 提供黑色 / 胜利色）
    ctx.clearRect(0, 0, w, h);

    // 胜利铺满动画（赢家圆圈膨胀到整屏）
    if (this.data.flooding) {
      const elapsed = now - this.floodStartAt;
      const t = Math.min(1, elapsed / FLOOD_DURATION);
      // 以所有赢家为中心扩张
      const maxRadius = Math.hypot(w, h);
      this.fingers.forEach((f) => {
        if (!this.winners.has(f.id)) return;
        const r = FINGER_RADIUS + (maxRadius - FINGER_RADIUS) * easeOutCubic(t);
        drawCircle(ctx, f.x, f.y, r, f.color, 1);
      });
      return;
    }

    // 正常态：绘制每个手指圆圈
    this.fingers.forEach((f) => {
      let radius = FINGER_RADIUS;
      let alpha = 1;

      if (f.state === 'spawning') {
        const t = Math.min(1, (now - f.createdAt) / SPAWN_DURATION);
        radius = FINGER_RADIUS * easeOutBack(t);
        if (t >= 1) f.state = 'alive';
      } else if (f.state === 'despawning') {
        const t = Math.min(1, (now - f.removedAt) / DESPAWN_DURATION);
        radius = FINGER_RADIUS * (1 - easeInCubic(t));
        alpha = 1 - t;
        if (t >= 1) {
          this.fingers.delete(f.id);
          return;
        }
      } else {
        // alive：呼吸
        const phase = ((now - f.createdAt) % BREATH_PERIOD) / BREATH_PERIOD;
        radius = FINGER_RADIUS + Math.sin(phase * Math.PI * 2) * BREATH_AMPLITUDE;
      }

      drawCircle(ctx, f.x, f.y, radius, f.color, alpha);
    });
  },

  // ---------------- 触摸处理 ----------------
  onTouchStart(e) {
    if (this.gameEnded) return;

    const now = Date.now();
    const touches = e.changedTouches || [];
    let added = 0;
    touches.forEach((t) => {
      if (this.fingers.has(t.identifier)) return;
      this.fingers.set(t.identifier, {
        id: t.identifier,
        x: t.x,
        y: t.y,
        color: randomColor(),
        createdAt: now,
        state: 'spawning',
        removedAt: 0
      });
      added++;
    });

    if (added > 0) {
      wx.vibrateShort({ type: 'light' });
      this.syncTouchCount();
      this.restartCountdown();
    }
  },

  onTouchMove(e) {
    if (this.gameEnded) return;
    const touches = e.touches || [];
    touches.forEach((t) => {
      const f = this.fingers.get(t.identifier);
      if (f && f.state !== 'despawning') {
        f.x = t.x;
        f.y = t.y;
      }
    });
  },

  onTouchEnd(e) {
    this.handleTouchRemove(e);
  },

  onTouchCancel(e) {
    this.handleTouchRemove(e);
  },

  handleTouchRemove(e) {
    if (this.gameEnded) return;
    const now = Date.now();
    const touches = e.changedTouches || [];
    touches.forEach((t) => {
      const f = this.fingers.get(t.identifier);
      if (f && f.state !== 'despawning') {
        f.state = 'despawning';
        f.removedAt = now;
      }
    });
    // 活跃手指数减少
    this.syncTouchCount();

    // 如果手指全部离开，取消倒计时
    if (this.activeFingerCount() === 0) {
      this.clearCountdown();
      this.setData({ countingDown: false, countdownText: '' });
    }
  },

  // ---------------- 倒计时 & 决胜 ----------------
  restartCountdown() {
    this.clearCountdown();
    if (this.activeFingerCount() === 0) return;

    this.setData({ countingDown: true, countdownText: '准备…' });
    this.countdownTimer = setTimeout(() => {
      this.pickWinners();
    }, COUNTDOWN_MS);
  },

  clearCountdown() {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
  },

  pickWinners() {
    const active = [];
    this.fingers.forEach((f) => {
      if (f.state !== 'despawning') active.push(f);
    });
    if (active.length === 0) {
      this.setData({ countingDown: false });
      return;
    }

    const n = Math.min(this.data.winnerCount, active.length);
    // Fisher-Yates 洗牌，绝对随机
    const pool = active.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const winnersArr = pool.slice(0, n);
    this.winners = new Set(winnersArr.map((f) => f.id));

    // 非赢家立即消失
    this.fingers.forEach((f) => {
      if (!this.winners.has(f.id)) {
        f.state = 'despawning';
        f.removedAt = Date.now();
      }
    });

    // 选第一个赢家的颜色作为铺满色
    const floodColor = winnersArr[0].color;
    this.gameEnded = true;
    this.floodStartAt = Date.now();
    this.setData({
      flooding: true,
      floodColor,
      countingDown: false,
      countdownText: ''
    });

    // 胜利长震动（2s）
    wx.vibrateLong && wx.vibrateLong();
  },

  // ---------------- 工具 ----------------
  activeFingerCount() {
    let c = 0;
    this.fingers.forEach((f) => { if (f.state !== 'despawning') c++; });
    return c;
  },

  syncTouchCount() {
    const c = this.activeFingerCount();
    if (c !== this.data.touchCount) {
      this.setData({ touchCount: c });
    }
  },

  // ---------------- UI 交互 ----------------
  incWinner() {
    if (this.data.winnerCount >= 5) return;
    this.setData({ winnerCount: this.data.winnerCount + 1 });
  },

  decWinner() {
    if (this.data.winnerCount <= 1) return;
    this.setData({ winnerCount: this.data.winnerCount - 1 });
  },

  stopPropagation() {
    // 阻止控制栏触摸冒泡到 stage，避免生成圆圈
  },

  resetGame() {
    this.fingers.clear();
    this.winners.clear();
    this.gameEnded = false;
    this.clearCountdown();
    this.setData({
      flooding: false,
      floodColor: '#000000',
      touchCount: 0,
      countingDown: false,
      countdownText: ''
    });
  }
});

// ---------------- 绘制工具 ----------------
function drawCircle(ctx, x, y, r, color, alpha) {
  if (r <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // 轻微光晕
  ctx.globalAlpha = alpha * 0.25;
  ctx.beginPath();
  ctx.arc(x, y, r + 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInCubic(t)  { return t * t * t; }
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
