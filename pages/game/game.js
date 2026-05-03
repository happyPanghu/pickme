// pages/game/game.js
// Chwazi 仿制：多指触摸随机选出赢家

const COUNTDOWN_MS = 3000;          // 连续 3 秒后定胜负
const MIN_PLAYERS = 2;              // 至少多少根手指按下才会开始倒计时
const GHOST_WATCHDOG_MS = 400;      // 幽灵手指守护阈值：创建后 > 此时间 且不在最近 touches 快照里 → 强制 despawn
const FINGER_RADIUS = 70;           // 手指圆的目标基础半径（px），实际半径会乘以每个手指自己的 sizeScale
const SPAWN_DURATION = 220;         // 圆圈从小到大的出现动画时长（ms）
const DESPAWN_DURATION = 180;       // 手指离开时缩小动画时长（ms）
const BREATH_AMPLITUDE = 8;         // 呼吸幅度（px）
const BREATH_PERIOD = 1100;         // 呼吸周期（ms）
const VICTORY_HOLD_MS = 1000;       // 胜出后保持强调展示的时长（ms），之后才铺屏
const VICTORY_MAX_SCALE = 1.8;      // 胜利强调阶段赢家圆圈最大放大倍数
const FLOOD_DURATION = 700;         // 胜者铺满屏幕动画时长（ms）
const SIZE_SCALE_MIN = 0.8;         // 每个手指圆的尺寸随机下限
const SIZE_SCALE_MAX = 1.0;         // 每个手指圆的尺寸随机上限

// 为每个新手指生成一个 [SIZE_SCALE_MIN, SIZE_SCALE_MAX] 之间的随机尺寸系数
// 让不同圆圈大小略有差异，画面更有生气，但差异控制在 20% 以内不影响识别
function randomSizeScale() {
  return SIZE_SCALE_MIN + Math.random() * (SIZE_SCALE_MAX - SIZE_SCALE_MIN);
}

// ---------------- 颜色生成 ----------------
// 策略：在 HSL 色彩空间程序化生成，理论上有无限多种颜色，永远不会"老是那几个"
// - 色相 H（hue）：0-360°，完整色轮随机
// - 饱和度 S：固定在 75%-100%（高饱和 → 鲜艳不发灰）
// - 亮度 L：固定在 55%-70%（黑色背景下必定清晰可见，又不至于过曝）
// - 相邻两次颜色的色相差 >= MIN_HUE_DISTANCE（40°），保证连续按下的圆颜色不接近
//
// 为了最大兼容性（某些老基础库 hsl() 渲染异常），生成后手动转为 rgb() 字符串。

const COLOR_SATURATION_MIN = 75;   // 饱和度下限（%）
const COLOR_SATURATION_MAX = 100;  // 饱和度上限（%）
const COLOR_LIGHTNESS_MIN = 55;    // 亮度下限（%），低于此在黑底上会暗
const COLOR_LIGHTNESS_MAX = 70;    // 亮度上限（%），高于此颜色会发白
const MIN_HUE_DISTANCE = 40;       // 相邻两次颜色的色相差最小值（度）
const MAX_HUE_RETRY = 8;           // 避免相邻色相过近的重采样次数上限

// 记录上一次使用的色相（度），用于下次生成时避开
let _lastHue = -1;

// HSL 转 RGB（标准算法，返回 rgb() 字符串）
// h: 0-360, s: 0-100, l: 0-100
function hslToRgbString(h, s, l) {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp >= 0 && hp < 1)      { r1 = c; g1 = x; b1 = 0; }
  else if (hp >= 1 && hp < 2) { r1 = x; g1 = c; b1 = 0; }
  else if (hp >= 2 && hp < 3) { r1 = 0; g1 = c; b1 = x; }
  else if (hp >= 3 && hp < 4) { r1 = 0; g1 = x; b1 = c; }
  else if (hp >= 4 && hp < 5) { r1 = x; g1 = 0; b1 = c; }
  else                        { r1 = c; g1 = 0; b1 = x; }
  const m = lNorm - c / 2;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  return 'rgb(' + r + ', ' + g + ', ' + b + ')';
}

// 计算两个色相（度）之间的最小圆周距离，范围 0-180
function hueDistance(h1, h2) {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

// 生成一个鲜艳、黑底可见、且不与上次相似的随机颜色
function randomColor() {
  let hue;
  // 最多尝试 MAX_HUE_RETRY 次，找一个与上次色相距离足够大的
  // 第一次（_lastHue === -1）直接接受
  for (let i = 0; i < MAX_HUE_RETRY; i++) {
    hue = Math.random() * 360;
    if (_lastHue < 0 || hueDistance(hue, _lastHue) >= MIN_HUE_DISTANCE) break;
  }
  _lastHue = hue;

  const saturation = COLOR_SATURATION_MIN +
    Math.random() * (COLOR_SATURATION_MAX - COLOR_SATURATION_MIN);
  const lightness = COLOR_LIGHTNESS_MIN +
    Math.random() * (COLOR_LIGHTNESS_MAX - COLOR_LIGHTNESS_MIN);

  return hslToRgbString(hue, saturation, lightness);
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

  onLoad() {
    // ---- 在 onLoad 里初始化运行时状态，避免 Page 字面量上属性被共享 ----
    this.fingers = new Map();   // identifier -> finger 对象
    this.winners = new Set();   // 赢家 identifier 集合
    // 赢家快照：pickWinners 后立即拍一份，供 flooding 阶段稳定使用，
    // 不依赖 fingers Map（那里的 finger 在动画过程中仍可能被回收）
    // 结构：[{ id, x, y, color, sizeScale }, ...]
    this.winnersSnapshot = [];
    this.countdownTimer = null;
    this.victoryTimer = null;   // 胜利 hold → flood 的延时定时器
    this.rafId = null;
    this.canvas = null;
    this.ctx = null;
    this.dpr = 1;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.victoryStartAt = 0;    // 进入胜利强调阶段的时间戳
    this.floodStartAt = 0;
    this.gameEnded = false;

    // watchdog：记录最近一次已知的系统 touches 快照 + 时间戳
    // 用于 render 循环里定期清理"无 touchend"场景下的幽灵 finger
    this._lastTouchIds = new Set();
    this._lastTouchesAt = 0;

    this.initCanvas();
  },

  onUnload() {
    this.stopLoop();
    this.clearCountdown();
    this.clearVictoryTimer();
  },

  // ---------------- Canvas 初始化 ----------------
  initCanvas() {
    const query = wx.createSelectorQuery();
    query.select('#gameCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          console.error('[initCanvas] canvas node not found');
          return;
        }
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const sysInfo = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync();
        const dpr = sysInfo.pixelRatio || 1;

        canvas.width = res[0].width * dpr;
        canvas.height = res[0].height * dpr;
        // 注意：不使用 ctx.scale(dpr, dpr)，因为某些基础库下
        // save/restore 或 canvas resize 会把 transform 重置掉，
        // 导致只有第一次绘制生效、后续圆圈看不见。
        // 改为在绘制时手动乘以 dpr。

        this.canvas = canvas;
        this.ctx = ctx;
        this.dpr = dpr;
        this.canvasWidth = res[0].width;
        this.canvasHeight = res[0].height;

        console.log('[initCanvas] width:', res[0].width, 'height:', res[0].height, 'dpr:', dpr);
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
    const dpr = this.dpr;
    const w = this.canvasWidth * dpr;
    const h = this.canvasHeight * dpr;

    // 清屏（透明，背景由 wxss 的 stage 提供黑色 / 胜利色）
    ctx.clearRect(0, 0, w, h);

    // 胜利铺满动画
    // - 1 个赢家：一个扩散圆铺满屏幕（和原来行为一致）
    // - N 个赢家（N≥2）：按 Voronoi 分区，每个赢家在自己的区域内扩散铺满
    //   视觉效果：每个赢家的颜色从自己的位置向外涌出，相遇处形成中垂线分界
    //   最终每个赢家占据离自己最近的那块区域（面积之和 = 整屏）
    if (this.data.flooding) {
      ctx.globalCompositeOperation = 'source-over';
      const elapsed = now - this.floodStartAt;
      const t = Math.min(1, elapsed / FLOOD_DURATION);
      const maxRadius = Math.hypot(this.canvasWidth, this.canvasHeight);

      // 先回收已完成 despawning 动画的非赢家 finger，避免 Map 残留污染下一局
      const floodToDelete = [];
      this.fingers.forEach((f) => {
        if (f.state === 'despawning' && now - f.removedAt >= DESPAWN_DURATION) {
          floodToDelete.push(f.id);
        }
      });
      for (let i = 0; i < floodToDelete.length; i++) {
        this.fingers.delete(floodToDelete[i]);
      }

      const winners = this.winnersSnapshot || [];
      if (winners.length === 0) {
        // 理论上不会发生（pickWinners 保证 winnersSnapshot 非空才进 flooding）
        // 兜底：直接黑屏，一帧后游戏流程继续
        return;
      }

      const easedT = easeOutCubic(t);
      const w = this.canvasWidth;
      const h = this.canvasHeight;

      if (winners.length === 1) {
        // 单赢家：原先的大圆扩散
        const only = winners[0];
        const startRadius = FINGER_RADIUS * VICTORY_MAX_SCALE * (only.sizeScale || 1);
        const r = startRadius + (maxRadius - startRadius) * easedT;
        drawCircle(ctx, only.x, only.y, r, only.color, 1, dpr);
        return;
      }

      // 多赢家：为每个赢家计算 Voronoi 凸多边形（以屏幕矩形为初始，
      // 依次用与其他赢家的"半平面"裁剪），然后在该多边形内画扩散圆
      // 多边形在每帧都一样（赢家位置固定），但计算量极小（n^2，n≤10），
      // 为保持代码简单直接在每帧重算而不做缓存
      const screenRect = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h }
      ];

      for (let i = 0; i < winners.length; i++) {
        const wi = winners[i];
        // 从屏幕矩形开始，用 wi 与其他每个 wj 的中垂线半平面依次裁剪
        let poly = screenRect;
        for (let j = 0; j < winners.length; j++) {
          if (i === j) continue;
          const wj = winners[j];
          // 保留靠近 wi 的那一侧（半平面：到 wi 的距离 ≤ 到 wj 的距离）
          poly = clipPolygonByHalfplaneCloserTo(poly, wi.x, wi.y, wj.x, wj.y);
          if (poly.length === 0) break;
        }
        if (poly.length < 3) continue;

        // 在多边形区域内画扩散圆
        const startRadius = FINGER_RADIUS * VICTORY_MAX_SCALE * (wi.sizeScale || 1);
        const r = startRadius + (maxRadius - startRadius) * easedT;

        ctx.save();
        // 裁剪到 Voronoi 多边形（坐标乘 dpr）
        ctx.beginPath();
        ctx.moveTo(poly[0].x * dpr, poly[0].y * dpr);
        for (let k = 1; k < poly.length; k++) {
          ctx.lineTo(poly[k].x * dpr, poly[k].y * dpr);
        }
        ctx.closePath();
        ctx.clip();

        // 在 clip 区域内画扩散圆：实心 + 光晕
        drawCircle(ctx, wi.x, wi.y, r, wi.color, 1, dpr);

        ctx.restore();
      }
      return;
    }

    // ---- 幽灵 watchdog：对"创建已超过 GHOST_WATCHDOG_MS 但不在最近系统 touches 快照里"
    //      的非 despawning finger，强制 despawn。
    // 这条是针对"快速点击但 touchend 事件丢失"的兜底：只要 render 循环还在跑，
    // 最多在 GHOST_WATCHDOG_MS 内就会被清理，不会永久残留。
    if (this._lastTouchesAt > 0 && !this.gameEnded) {
      this.fingers.forEach((f) => {
        if (f.state === 'despawning' || f.state === 'victory') return;
        // 最近的 touches 快照里不存在 + 创建时间已足够久 → 认定为幽灵
        if (!this._lastTouchIds.has(f.id) && now - f.createdAt >= GHOST_WATCHDOG_MS) {
          console.log('[watchdog] ghost finger detected, despawn id:', f.id,
            'age:', now - f.createdAt, 'ms');
          f.state = 'despawning';
          f.removedAt = now;
        }
      });
    }

    // 正常态 / 胜利强调态：两阶段绘制 + lighter 混合
    ctx.globalCompositeOperation = 'lighter';

    const toDelete = [];
    // 先算一次每个手指的半径/透明度，缓存起来给两个阶段用
    const drawables = [];
    // 胜利强调阶段进度（0~1），仅当进入 victory 状态后有意义
    const victoryT = this.victoryStartAt > 0
      ? Math.min(1, (now - this.victoryStartAt) / VICTORY_HOLD_MS)
      : 0;

    this.fingers.forEach((f) => {
      if (typeof f.x !== 'number' || typeof f.y !== 'number') {
        toDelete.push(f.id);
        return;
      }
      // 每个手指独立的基础半径：70px * 自己的 sizeScale（0.8~1.0）
      // 所有状态下的半径计算都基于 baseRadius，保证差异性统一贯穿整个生命周期
      const scale = f.sizeScale || 1;
      const baseRadius = FINGER_RADIUS * scale;

      let radius = baseRadius;
      let alpha = 1;
      let glowBoost = 1;   // 光晕放大倍数，赢家强调时拉高

      if (f.state === 'spawning') {
        const t = Math.min(1, (now - f.createdAt) / SPAWN_DURATION);
        radius = baseRadius * easeOutBack(t);
        if (t >= 1) f.state = 'alive';
      } else if (f.state === 'despawning') {
        const t = Math.min(1, (now - f.removedAt) / DESPAWN_DURATION);
        radius = baseRadius * (1 - easeInCubic(t));
        alpha = 1 - t;
        if (t >= 1) {
          toDelete.push(f.id);
          return;
        }
      } else if (f.state === 'victory') {
        // 赢家强调：1s 内圆圈从 baseRadius 平滑放大到 baseRadius * VICTORY_MAX_SCALE
        // 同时保留一丝"脉冲"呼吸感，光晕逐步放大
        const pulse = Math.sin(victoryT * Math.PI * 6) * 6; // 轻微脉冲
        radius = baseRadius * (1 + (VICTORY_MAX_SCALE - 1) * easeOutCubic(victoryT)) + pulse;
        glowBoost = 1 + 2.5 * victoryT; // 光晕越来越亮
      } else {
        // alive：呼吸（呼吸幅度也要按 scale 缩放，避免小圆呼吸幅度显得过大）
        const phase = ((now - f.createdAt) % BREATH_PERIOD) / BREATH_PERIOD;
        radius = baseRadius + Math.sin(phase * Math.PI * 2) * BREATH_AMPLITUDE * scale;
      }

      if (radius > 0) {
        drawables.push({ x: f.x, y: f.y, r: radius, color: f.color, alpha, glowBoost });
      }
    });

    // 阶段 1：光晕
    for (let i = 0; i < drawables.length; i++) {
      const d = drawables[i];
      drawGlow(ctx, d.x, d.y, d.r, d.color, d.alpha, dpr, d.glowBoost);
    }
    // 阶段 2：实心圆
    for (let i = 0; i < drawables.length; i++) {
      const d = drawables[i];
      drawSolid(ctx, d.x, d.y, d.r, d.color, d.alpha, dpr);
    }

    // 还原混合模式，避免其他地方误用（例如下一帧 clearRect 行为）
    ctx.globalCompositeOperation = 'source-over';

    for (let i = 0; i < toDelete.length; i++) {
      this.fingers.delete(toDelete[i]);
    }
  },

  // ---------------- 触摸处理 ----------------
  onTouchStart(e) {
    // 胜利画面下，用户重新按下手指 → 自动开启新一局
    if (this.gameEnded) {
      this.resetGame();
    }

    const now = Date.now();
    const changed = e.changedTouches || [];
    const allTouches = e.touches || [];
    console.log('[onTouchStart] changed:', changed.length,
      'allTouches:', allTouches.length,
      'fingersBefore:', this.fingers.size);

    // ---- 关键修复：以系统 e.touches 为权威，清理 Map 里的"幽灵手指" ----
    // 当 touchend 事件丢失（小程序/原生组件已知问题），Map 里会残留旧 finger。
    // e.touches 是当前屏幕上真实存在的所有手指，不在里面的一定是幽灵，立即清理。
    this.reconcileFingersWith(allTouches, now);

    let added = 0;
    // 收集本轮新添加/刷新的 id，用于稍后与 allTouches 合并更新快照
    const freshIds = [];
    changed.forEach((t) => {
      // 坐标兼容：小程序 touch.x 在某些场景下为 undefined，回退到其它字段
      const tx = pickCoord(t, 'x');
      const ty = pickCoord(t, 'y');
      if (typeof tx !== 'number' || typeof ty !== 'number') {
        console.warn('[onTouchStart] skip invalid coord, raw touch:', JSON.stringify(t));
        return;
      }

      if (this.fingers.has(t.identifier)) {
        // 同一 id 再次 touchstart，多半是系统复用 id，更新坐标并重置状态
        const f = this.fingers.get(t.identifier);
        f.x = tx;
        f.y = ty;
        f.color = randomColor();
        f.sizeScale = randomSizeScale();   // 重新随机一个尺寸
        f.createdAt = now;
        f.state = 'spawning';
        f.removedAt = 0;
        console.log('[onTouchStart] refresh existing id:', t.identifier);
        freshIds.push(t.identifier);
        added++;
        return;
      }
      this.fingers.set(t.identifier, {
        id: t.identifier,
        x: tx,
        y: ty,
        color: randomColor(),
        sizeScale: randomSizeScale(),      // 每个手指独立的尺寸系数，0.8~1.0
        createdAt: now,
        state: 'spawning',
        removedAt: 0
      });
      freshIds.push(t.identifier);
      added++;
      console.log('[onTouchStart] add id:', t.identifier, 'pos:', tx, ty, 'scale:',
        this.fingers.get(t.identifier).sizeScale.toFixed(2));
    });

    console.log('[onTouchStart] fingersAfter:', this.fingers.size, 'added:', added);

    // 在 Map 更新完毕后再更新 watchdog 快照：
    // 把 allTouches 和刚 changedTouches 的 id 合并，确保新添加的 finger 一定在快照里
    // （防止 iOS 在某些机型下 allTouches 未包含新按下的 identifier 导致 watchdog 误杀）
    this._updateTouchSnapshot(allTouches, now, freshIds);

    if (added > 0) {
      wx.vibrateShort({ type: 'light' });
      this.syncTouchCount();
      this.restartCountdown();
    }
  },

  onTouchMove(e) {
    if (this.gameEnded) return;
    const now = Date.now();
    const touches = e.touches || [];
    touches.forEach((t) => {
      const f = this.fingers.get(t.identifier);
      if (f && f.state !== 'despawning') {
        const tx = pickCoord(t, 'x');
        const ty = pickCoord(t, 'y');
        if (typeof tx === 'number') f.x = tx;
        if (typeof ty === 'number') f.y = ty;
      }
    });
    // 持续更新 watchdog 快照：覆盖"部分 touchend 丢失但其他手指仍在 move"的场景
    // 比如 A+B 按下 → A 的 touchend 丢失 → B 继续 move，此时 e.touches=[B]
    // 借助这次 move 更新快照后，watchdog 就能识别出 A 是幽灵并清理掉
    this._updateTouchSnapshot(touches, now);
  },

  onTouchEnd(e) {
    this.handleTouchRemove(e);
  },

  onTouchCancel(e) {
    this.handleTouchRemove(e);
  },

  handleTouchRemove(e) {
    const now = Date.now();
    const changed = e.changedTouches || [];
    const allTouches = e.touches || [];
    console.log('[handleTouchRemove] changed:', changed.length,
      'allTouches:', allTouches.length,
      'fingersBefore:', this.fingers.size);

    // 1) 先把 changed 里的 finger 标记为 despawning
    // 这样接下来 _updateTouchSnapshot 做"allTouches 是否覆盖 Map 活跃 finger"判断时，
    // 这批刚抬起的 finger 不会被算作"未覆盖"而导致快照更新被跳过
    changed.forEach((t) => {
      const f = this.fingers.get(t.identifier);
      if (f && f.state !== 'despawning') {
        f.state = 'despawning';
        f.removedAt = now;
      }
    });

    // 2) 此时再更新 watchdog 快照（despawning 的 finger 会被自动忽略，判定正常）
    this._updateTouchSnapshot(allTouches, now);

    // 3) 再用 e.touches 做一次 reconcile，防止有幽灵手指
    this.reconcileFingersWith(allTouches, now);

    this.syncTouchCount();

    if (this.gameEnded) return;

    // 任何抬指导致活跃手指数 < MIN_PLAYERS，都立刻取消倒计时
    if (this.activeFingerCount() < MIN_PLAYERS) {
      this.clearCountdown();
      if (this.data.countingDown) {
        this.setData({ countingDown: false, countdownText: '' });
      }
    }
  },

  // 更新最近一次已知的系统 touches 快照，供 render 里的 watchdog 使用
  //
  // ⚠️ 关键：iOS/微信 e.touches 最多返回 5 根手指，第 6 根按下时快照可能不完整。
  // 如果此时盲目更新 _lastTouchIds，watchdog 会在 400ms 后把老手指全部误杀清空。
  //
  // 策略：只有当 allTouches（+ 可选的 extraIds）完整覆盖当前 Map 里所有活跃 finger 时，
  // 才认为快照可信、更新它。反之保留上一次的可信快照
  // （宁可多等一会儿让 watchdog 暂时失效，也不允许误杀）。
  //
  // 参数：
  //   allTouches  系统 e.touches 快照
  //   now         当前时间戳
  //   extraIds    （可选）本次事件中刚被加入 Map 的 finger id 列表
  //               用于规避"iOS 在 touchstart 瞬间 allTouches 未必含新按下 id"的兼容问题
  _updateTouchSnapshot(allTouches, now, extraIds) {
    const newIds = new Set();
    for (let i = 0; i < allTouches.length; i++) {
      newIds.add(allTouches[i].identifier);
    }
    if (extraIds && extraIds.length) {
      for (let i = 0; i < extraIds.length; i++) {
        newIds.add(extraIds[i]);
      }
    }

    // 检查新快照是否能覆盖当前 Map 里所有活跃（非 despawning）finger
    let uncovered = 0;
    this.fingers.forEach((f) => {
      if (f.state === 'despawning') return;
      if (!newIds.has(f.id)) uncovered++;
    });

    if (uncovered > 0) {
      // 快照不完整（典型场景：第 6 指按下时 iOS 只给 5 个 touches），放弃本次更新
      console.log('[snapshot] skip: incomplete, allTouches:', allTouches.length,
        'extra:', (extraIds && extraIds.length) || 0,
        'uncovered:', uncovered);
      return;
    }

    this._lastTouchIds = newIds;
    this._lastTouchesAt = now;
  },

  // 以系统 e.touches（当前真实在屏手指）为权威，把 Map 里不存在的 finger
  // 立即标为 despawning（如果还活着），以规避 touchend 丢失问题。
  //
  // ⚠️ 重要：iOS/微信 e.touches 最多返回 5 根手指，当第 6 根按下时
  // allTouches.length = 5 但屏幕真实有 6 根。此时若盲目 reconcile 会
  // 把 Map 里的老手指全部误判为"幽灵"清空掉。
  // 策略：仅当 allTouches 覆盖了 Map 中所有活跃 finger 时才相信它。
  reconcileFingersWith(allTouches, now) {
    const aliveIds = new Set();
    for (let i = 0; i < allTouches.length; i++) {
      aliveIds.add(allTouches[i].identifier);
    }

    // 统计 Map 里的活跃 finger id（非 despawning）
    const activeFingerIds = [];
    this.fingers.forEach((f) => {
      if (f.state !== 'despawning') activeFingerIds.push(f.id);
    });

    // 计算有多少 Map 活跃 finger 被 allTouches 覆盖
    let covered = 0;
    for (let i = 0; i < activeFingerIds.length; i++) {
      if (aliveIds.has(activeFingerIds[i])) covered++;
    }

    // 如果 allTouches 没有完全覆盖我们的活跃 finger（说明系统给的快照不完整，
    // 比如 5 指上限或者部分手指 id 没在 e.touches 里），不做任何清理，避免误杀。
    if (covered < activeFingerIds.length) {
      console.log('[reconcile] skip: allTouches incomplete,',
        'covered:', covered, 'activeFingers:', activeFingerIds.length,
        'allTouches:', allTouches.length);
      return;
    }

    // allTouches 完整覆盖时，把 Map 里不在 allTouches 里的手指标为幽灵
    // （正常情况下这里 covered === activeFingerIds.length，不会有幽灵；
    //  但若 Map 有但 allTouches 没有，就是真幽灵，放心清掉）
    this.fingers.forEach((f) => {
      if (f.state === 'despawning') return;
      if (!aliveIds.has(f.id)) {
        console.log('[reconcile] mark ghost finger despawning, id:', f.id);
        f.state = 'despawning';
        f.removedAt = now;
      }
    });
  },

  // ---------------- 倒计时 & 决胜 ----------------
  restartCountdown() {
    this.clearCountdown();
    // 至少要有 MIN_PLAYERS 根手指才开始倒计时
    if (this.activeFingerCount() < MIN_PLAYERS) {
      // 未达起跑线：确保倒计时 UI 也是关闭的
      if (this.data.countingDown) {
        this.setData({ countingDown: false, countdownText: '' });
      }
      return;
    }

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
      this.setData({ countingDown: false, countdownText: '' });
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

    // 拍一份赢家稳定快照（id / 位置 / 颜色 / sizeScale），
    // 在 flooding 阶段独立使用，不受 fingers Map 后续清理影响
    // 过滤掉坐标无效的 finger（防御性：理论上 pickWinners 看到的 finger 坐标都有效）
    this.winnersSnapshot = winnersArr
      .filter((f) => typeof f.x === 'number' && typeof f.y === 'number')
      .map((f) => ({
        id: f.id,
        x: f.x,
        y: f.y,
        color: f.color,
        sizeScale: f.sizeScale || 1
      }));

    // 1) 非赢家立即进入 despawning，180ms 内淡出消失
    const tNow = Date.now();
    this.fingers.forEach((f) => {
      if (!this.winners.has(f.id)) {
        f.state = 'despawning';
        f.removedAt = tNow;
      } else {
        // 赢家进入 victory 强调状态
        f.state = 'victory';
      }
    });

    // 2) 游戏进入结算，但先只是"强调赢家"，不立刻铺屏
    this.gameEnded = true;
    this.victoryStartAt = tNow;
    this.setData({
      countingDown: false,
      countdownText: ''
    });

    // 胜利轻震一下，标识决胜时刻
    wx.vibrateShort && wx.vibrateShort({ type: 'heavy' });

    // 3) 延迟 VICTORY_HOLD_MS 后再触发真正的铺屏
    const floodColor = winnersArr[0].color;
    this.clearVictoryTimer();
    this.victoryTimer = setTimeout(() => {
      this.victoryTimer = null;
      this.floodStartAt = Date.now();
      this.setData({
        flooding: true,
        floodColor
      });
      // 铺屏开始时长震，和视觉铺满同步
      wx.vibrateLong && wx.vibrateLong();
    }, VICTORY_HOLD_MS);
  },

  clearVictoryTimer() {
    if (this.victoryTimer) {
      clearTimeout(this.victoryTimer);
      this.victoryTimer = null;
    }
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
  incWinner(e) {
    console.log('[incWinner] triggered, current:', this.data.winnerCount, 'event:', e && e.type);
    // 无上限：赢家数在实际开奖时会被 Math.min(winnerCount, activeFingers) 自动约束
    this.setData({ winnerCount: this.data.winnerCount + 1 });
  },

  decWinner(e) {
    console.log('[decWinner] triggered, current:', this.data.winnerCount, 'event:', e && e.type);
    if (this.data.winnerCount <= 1) {
      console.log('[decWinner] reached min, ignore');
      return;
    }
    this.setData({ winnerCount: this.data.winnerCount - 1 });
  },

  // 给按钮自己绑 touchstart 做"备用方案"：即使 tap 合成失败，
  // touchstart 也能直接触发加减。touchstart 还能 catch 掉向上冒泡，不生成圆圈。
  onDecTouch(e) {
    console.log('[onDecTouch] triggered');
    this.decWinner(e);
  },
  onIncTouch(e) {
    console.log('[onIncTouch] triggered');
    this.incWinner(e);
  },

  resetGame() {
    this.fingers.clear();
    this.winners.clear();
    this.winnersSnapshot = [];
    this.gameEnded = false;
    this.victoryStartAt = 0;
    this.floodStartAt = 0;
    // 重置 touches 快照：防止 watchdog 误用旧快照
    this._lastTouchIds.clear();
    this._lastTouchesAt = 0;
    this.clearCountdown();
    this.clearVictoryTimer();
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
// 注意：x/y/r 传入的都是逻辑像素（CSS px），内部乘以 dpr 得到物理像素。
// 不使用 ctx.save/restore，避免基础库下 transform 异常。
// 胜利铺屏时还用的旧接口：一次画完光晕+实心
function drawCircle(ctx, x, y, r, color, alpha, dpr) {
  if (r <= 0) return;
  drawGlow(ctx, x, y, r, color, alpha, dpr);
  drawSolid(ctx, x, y, r, color, alpha, dpr);
  ctx.globalAlpha = 1;
}

// 仅画光晕
// glowBoost：光晕半径增量的倍数（胜利强调时增强）
function drawGlow(ctx, x, y, r, color, alpha, dpr, glowBoost) {
  if (r <= 0) return;
  const boost = typeof glowBoost === 'number' ? glowBoost : 1;
  ctx.globalAlpha = alpha * 0.25;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x * dpr, y * dpr, (r + 10 * boost) * dpr, 0, Math.PI * 2);
  ctx.fill();
}

// 仅画实心圆
function drawSolid(ctx, x, y, r, color, alpha, dpr) {
  if (r <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x * dpr, y * dpr, r * dpr, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------- 几何工具（多赢家 Voronoi 分区用）----------------
// 用"到 A 更近"的半平面裁剪一个凸多边形（Sutherland-Hodgman 算法）
//
// 半平面定义：保留所有"到 A 的距离 ≤ 到 B 的距离"的点
// 这等价于保留 AB 中垂线 A 一侧（含中垂线本身）的点。
//
// 数学推导：|PA|² ≤ |PB|² 展开后
//   (Px - Ax)² + (Py - Ay)² ≤ (Px - Bx)² + (Py - By)²
//   化简：2(Bx - Ax)·Px + 2(By - Ay)·Py ≤ (Bx² + By²) - (Ax² + Ay²)
// 记 nx = Bx - Ax, ny = By - Ay, d = (Bx² + By² - Ax² - Ay²) / 2
// 则半平面为：nx·Px + ny·Py ≤ d （点在半平面内）
//
// 参数：
//   poly  凸多边形顶点数组，顺序为顺时针或逆时针皆可，每项 {x, y}
//   ax,ay 参考点 A（保留靠近 A 的一侧）
//   bx,by 参考点 B
// 返回：裁剪后的新多边形（可能为空数组或少于 3 个顶点）
//
// 边界情况：当 A 与 B 重合（距离 < EPSILON）时，中垂线不存在，
// 此时按约定返回原多边形不动（相当于两点共享同一区域，行为退化为单赢家）。
function clipPolygonByHalfplaneCloserTo(poly, ax, ay, bx, by) {
  if (!poly || poly.length === 0) return [];
  const nx = bx - ax;
  const ny = by - ay;
  // 退化情况：A、B 几乎重合，半平面无意义，直接返回原多边形（不裁剪）
  const EPSILON = 1e-6;
  if (nx * nx + ny * ny < EPSILON) return poly.slice();
  const d = (bx * bx + by * by - ax * ax - ay * ay) / 2;
  // side(P) = nx*Px + ny*Py - d，≤ 0 表示 P 在半平面内（靠近 A 一侧）
  const side = (p) => nx * p.x + ny * p.y - d;

  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const curr = poly[i];
    const prev = poly[(i - 1 + n) % n];
    const sCurr = side(curr);
    const sPrev = side(prev);
    const currIn = sCurr <= 0;
    const prevIn = sPrev <= 0;

    if (currIn) {
      if (!prevIn) {
        // prev 在外、curr 在内：先输出交点，再输出 curr
        out.push(intersectEdgeWithHalfplane(prev, curr, sPrev, sCurr));
      }
      out.push(curr);
    } else if (prevIn) {
      // prev 在内、curr 在外：只输出交点
      out.push(intersectEdgeWithHalfplane(prev, curr, sPrev, sCurr));
    }
    // prev 和 curr 都在外：什么都不输出
  }
  return out;
}

// 线段 (p1, p2) 与半平面边界（side 值分别为 s1, s2，异号）的交点
// 线性插值：t = s1 / (s1 - s2)，交点 = p1 + (p2 - p1) * t
function intersectEdgeWithHalfplane(p1, p2, s1, s2) {
  const denom = s1 - s2;
  // 理论上 denom 不会为 0（调用方保证 s1 和 s2 异号）；防御性处理避免除零
  const t = denom === 0 ? 0 : s1 / denom;
  return {
    x: p1.x + (p2.x - p1.x) * t,
    y: p1.y + (p2.y - p1.y) * t
  };
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInCubic(t)  { return t * t * t; }
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// 小程序 touch 对象的坐标字段兼容：
// 标准字段是 x/y（相对于 page），但在某些真机/基础库下只有 pageX/clientX。
function pickCoord(touch, axis) {
  if (!touch) return undefined;
  const v1 = touch[axis];
  if (typeof v1 === 'number') return v1;
  const v2 = touch['page' + axis.toUpperCase()];
  if (typeof v2 === 'number') return v2;
  const v3 = touch['client' + axis.toUpperCase()];
  if (typeof v3 === 'number') return v3;
  return undefined;
}
