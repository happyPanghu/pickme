// Canvas 渲染器：每帧绘制所有手指圆 + 结算强调 + 铺屏分区
//
// 分阶段（由 page 层通过 setStage 切换）：
//   'idle'       正常手指展示：呼吸动画 + spawning 弹入 + despawning 淡出
//   'showdown'   抉择阶段：2 个候选圆高频 ping-pong 反相切换（强反差）
//   'victory'    赢家强调：输家快速淡出，赢家放大到 1.8× 带脉冲光晕
//   'flooding'   铺屏阶段：按 Group 列表画 Voronoi 分区，色块从锚点扩散铺满
//
// 所有阶段共用同一个 RAF loop，由 stage 状态决定走哪个分支。

const { cellFor } = require('../core/voronoi.js');
const { groupAnchor } = require('../core/winnerStrategy.js');

// 动画参数（与玩家感知直接相关，集中在这里方便调整）
const SPAWN_DURATION    = 220;   // 弹入
const DESPAWN_DURATION  = 180;   // 输家淡出
const BREATH_PERIOD     = 1100;  // 呼吸周期
const BREATH_AMPLITUDE  = 8;     // 呼吸幅度 px
const BASE_RADIUS       = 70;    // 基础半径 px
const GLOW_RADIUS       = 120;   // 光晕半径 px
const VICTORY_SCALE     = 1.8;   // 赢家放大倍数
const VICTORY_PULSE_AMP = 0.08;  // 赢家脉冲幅度（相对 1.8×）
const VICTORY_PULSE_P   = 600;   // 赢家脉冲周期

// ---- 抉择阶段 ping-pong 参数 ----
// 翻转周期：一个完整的"A 亮→A 暗→A 亮"循环时长。250ms 对应 4Hz 翻转。
// 人眼主观感觉：既强烈又不至于闪得让人不适（临界频率）。
const SHOWDOWN_PING_PERIOD_MS = 250;
// 亮态视觉：相对基础半径的倍数 + alpha
const SHOWDOWN_BRIGHT_SCALE = 2.0;
const SHOWDOWN_BRIGHT_ALPHA = 1.0;
// 暗态视觉：几乎熄灭
const SHOWDOWN_DIM_SCALE = 0.4;
const SHOWDOWN_DIM_ALPHA = 0.15;

// easeOutBack：弹入动画曲线（稍微过冲一下更有"啵"的感觉）
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const v = t - 1;
  return 1 + c3 * v * v * v + c1 * v * v;
}

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

function createRenderer(deps) {
  const store = deps.store;
  const watchdog = deps.watchdog;
  // getter 形式：page 随时可能换 stage 状态，每帧都取最新
  const getStage = deps.getStage;           // () => 'idle' | 'showdown' | 'victory' | 'flooding'
  const getCountdownRemaining = deps.getCountdownRemaining; // () => number，未倒计时时返回 Infinity
  const getVictoryStartedAt = deps.getVictoryStartedAt;     // () => number
  const getFloodStartedAt = deps.getFloodStartedAt;         // () => number
  const getShowdownStartedAt = deps.getShowdownStartedAt || (() => 0); // () => number
  const getGroups = deps.getGroups;         // () => Group[]（仅 victory/flooding 阶段用）

  // 为 showdown 阶段预建的 id→index 缓存：按 id 升序给候选编 0/1 号，
  // 用于决定 ping-pong 反相。缓存在 stage 切换时按需重算。
  let _showdownIdIndex = null;        // Map<id, 0|1>
  let _showdownIndexBuiltAt = 0;      // 上次构建时对应的 showdownStartedAt，用于失效判定

  let canvas = null;
  let ctx = null;
  let rafId = 0;
  let running = false;
  let dpr = 1;
  let cssWidth = 0;
  let cssHeight = 0;

  // 初始化 canvas：拿到 context、适配 dpr
  function init(selectorRoot) {
    return new Promise((resolve, reject) => {
      const query = selectorRoot.createSelectorQuery();
      query.select('#stage')
        .fields({ node: true, size: true })
        .exec((res) => {
          if (!res || !res[0] || !res[0].node) {
            reject(new Error('canvas node not found'));
            return;
          }
          canvas = res[0].node;
          ctx = canvas.getContext('2d');
          const sysInfo = wx.getSystemInfoSync();
          dpr = sysInfo.pixelRatio || 1;
          cssWidth = res[0].width || sysInfo.windowWidth;
          cssHeight = res[0].height || sysInfo.windowHeight;
          canvas.width = cssWidth * dpr;
          canvas.height = cssHeight * dpr;
          ctx.scale(dpr, dpr);
          resolve({ cssWidth, cssHeight, dpr });
        });
    });
  }

  function start() {
    if (running) return;
    running = true;
    loop();
  }

  function stop() {
    running = false;
    if (rafId && canvas && canvas.cancelAnimationFrame) {
      canvas.cancelAnimationFrame(rafId);
    }
    rafId = 0;
  }

  function loop() {
    if (!running) return;
    const now = Date.now();

    // 每帧先让 watchdog 扫一下幽灵
    watchdog.sweep(now);

    // 清理已经退场动画走完的 finger（状态机推进）
    advanceLifecycle(now);

    draw(now);

    if (canvas && canvas.requestAnimationFrame) {
      rafId = canvas.requestAnimationFrame(loop);
    }
  }

  // spawning 动画到头 → alive；despawning 动画到头 → 从 Map 删除
  // showdown / victory 不参与自动状态流转，由 page 层驱动
  function advanceLifecycle(now) {
    const toDelete = [];
    store.forEach((f) => {
      if (f.state === 'spawning' && now - f.createdAt >= SPAWN_DURATION) {
        f.state = 'alive';
      } else if (f.state === 'despawning' && now - f.removedAt >= DESPAWN_DURATION) {
        toDelete.push(f.id);
      }
    });
    for (let i = 0; i < toDelete.length; i++) {
      store.remove(toDelete[i]);
    }
  }

  // 构建 showdown 阶段的 id→index 映射。
  // showdownStart 变化（比如重开新局后又进入 showdown）时自动失效重建。
  function _ensureShowdownIndex(showdownStart) {
    if (_showdownIdIndex && _showdownIndexBuiltAt === showdownStart) return;
    const list = [];
    store.forEach((f) => {
      if (f.state === 'showdown') list.push(f);
    });
    // 按 id 升序，保证每帧 A/B 相位一致（和 fingerStore.showdownList 同样的排序）
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const map = new Map();
    for (let i = 0; i < list.length; i++) map.set(list[i].id, i);
    _showdownIdIndex = map;
    _showdownIndexBuiltAt = showdownStart;
  }

  function draw(now) {
    if (!ctx) return;
    const stage = getStage();

    // 清屏
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (stage === 'flooding') {
      drawFlooding(now);
      return;
    }

    // idle / victory 共用圆绘制，只是 victory 阶段赢家会被放大 + 输家加速淡出
    // 用加法混合让光晕相交时更亮
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    store.forEach((f) => drawFinger(f, now, stage));
    ctx.restore();
  }

  function drawFinger(f, now, stage) {
    // 基础尺寸
    const base = BASE_RADIUS * f.sizeScale;

    // 计算本帧半径 + 整体 alpha
    let r = base;
    let alpha = 1;

    if (f.state === 'spawning') {
      const t = Math.min(1, (now - f.createdAt) / SPAWN_DURATION);
      const k = easeOutBack(t);
      r = base * k;
      alpha = Math.min(1, t * 1.4);
    } else if (f.state === 'alive') {
      // 呼吸（所有阶段通用，不再单独做"最后 1s 闪烁"——那已被 showdown 状态接管）
      const phase = ((now - f.createdAt) % BREATH_PERIOD) / BREATH_PERIOD;
      r = base + Math.sin(phase * Math.PI * 2) * BREATH_AMPLITUDE;
    } else if (f.state === 'showdown') {
      // ---- 抉择阶段核心视觉：2 个候选高频 ping-pong ----
      // index=0 的候选：周期内前半亮后半暗
      // index=1 的候选：反相，前半暗后半亮
      // 用余弦波形做过渡（感知比硬切更连续，但因为反差幅度极大依然很强烈）
      const showdownStart = getShowdownStartedAt();
      _ensureShowdownIndex(showdownStart);
      const idx = _showdownIdIndex ? (_showdownIdIndex.get(f.id) || 0) : 0;
      const tSinceStart = Math.max(0, now - showdownStart);
      // 相位：0~1 循环；index=1 偏移 0.5 实现反相
      const rawPhase = (tSinceStart % SHOWDOWN_PING_PERIOD_MS) / SHOWDOWN_PING_PERIOD_MS;
      const phase = (rawPhase + idx * 0.5) % 1;
      // 余弦波：phase=0 时 k=1（最亮），phase=0.5 时 k=0（最暗），phase=1 回到最亮
      const k = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);
      // 亮/暗属性线性插值
      const scale = SHOWDOWN_DIM_SCALE + (SHOWDOWN_BRIGHT_SCALE - SHOWDOWN_DIM_SCALE) * k;
      alpha = SHOWDOWN_DIM_ALPHA + (SHOWDOWN_BRIGHT_ALPHA - SHOWDOWN_DIM_ALPHA) * k;
      r = base * scale;
      // 把 k 挂到 f 上让后面光晕绘制能读到（避免重复计算）
      f._showdownK = k;
    } else if (f.state === 'despawning') {
      const t = Math.min(1, (now - f.removedAt) / DESPAWN_DURATION);
      const k = easeOutQuad(t);
      r = base * (1 - k * 0.2);
      alpha = 1 - k;
    } else if (f.state === 'victory') {
      const victoryStart = getVictoryStartedAt();
      const sinceVic = Math.max(0, now - victoryStart);
      // 前 300ms 平滑放大到 VICTORY_SCALE，之后持续脉冲
      const scaleEase = Math.min(1, sinceVic / 300);
      const scale = 1 + (VICTORY_SCALE - 1) * easeOutQuad(scaleEase);
      const pulse = 1 + VICTORY_PULSE_AMP * Math.sin((now / VICTORY_PULSE_P) * Math.PI * 2);
      r = base * scale * pulse;
      alpha = 1;
    }

    if (r <= 0 || alpha <= 0) return;

    // 外光晕：showdown 亮相时叠加一圈白色爆闪光晕，强化"被选中"的冲击感
    let glowMult = 1;
    if (f.state === 'victory') glowMult = 1.6;
    else if (f.state === 'showdown') glowMult = 1 + (f._showdownK || 0) * 1.4; // 最亮时 2.4×
    const glowR = GLOW_RADIUS * f.sizeScale * glowMult;
    const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, glowR);
    grad.addColorStop(0, colorWithAlpha(f.color, 0.55 * alpha));
    grad.addColorStop(1, colorWithAlpha(f.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(f.x, f.y, glowR, 0, Math.PI * 2);
    ctx.fill();

    // 实心圆
    ctx.fillStyle = colorWithAlpha(f.color, alpha);
    ctx.beginPath();
    ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
    ctx.fill();

    // 内部高光：让圆更像"果冻"
    const hiR = r * 0.35;
    const hiX = f.x - r * 0.25;
    const hiY = f.y - r * 0.3;
    const hiGrad = ctx.createRadialGradient(hiX, hiY, 0, hiX, hiY, hiR);
    hiGrad.addColorStop(0, 'rgba(255,255,255,' + (0.35 * alpha) + ')');
    hiGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hiGrad;
    ctx.beginPath();
    ctx.arc(hiX, hiY, hiR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Voronoi 铺屏：每组 Group 占据自己锚点对应的 Voronoi 单元，色块从锚点向外扩散直至铺满
  function drawFlooding(now) {
    const groups = getGroups();
    if (!groups || groups.length === 0) return;

    const floodStart = getFloodStartedAt();
    const sinceFlood = Math.max(0, now - floodStart);
    const FLOOD_DURATION = 700;
    const progress = Math.min(1, sinceFlood / FLOOD_DURATION);
    const eased = easeOutQuad(progress);

    const anchors = groups.map(groupAnchor);

    // 各组的"扩散半径"：取屏幕对角线保证能完全铺满
    const diag = Math.sqrt(cssWidth * cssWidth + cssHeight * cssHeight);

    if (groups.length === 1) {
      // 单赢家：不需要 Voronoi，整屏一色从锚点扩散
      const a = anchors[0];
      const r = diag * eased;
      ctx.save();
      ctx.fillStyle = groups[0].color;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 扩散完成后，画中央的持续脉冲圆（视觉焦点）
      if (progress >= 1) {
        drawCenterPulse(a, groups[0].color, now);
      }
      return;
    }

    // 多赢家：每组一个 Voronoi 单元 + clip 进去画扩散圆
    for (let i = 0; i < groups.length; i++) {
      const poly = cellFor(anchors, i, cssWidth, cssHeight);
      if (poly.length < 3) continue;

      ctx.save();
      // clip 到 Voronoi 单元里
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let k = 1; k < poly.length; k++) {
        ctx.lineTo(poly[k].x, poly[k].y);
      }
      ctx.closePath();
      ctx.clip();

      // 在 clip 内画一个从锚点扩散的圆；半径足够大就铺满这块分区
      const a = anchors[i];
      const r = diag * eased;
      ctx.fillStyle = groups[i].color;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.fill();

      if (progress >= 1) {
        drawCenterPulse(a, groups[i].color, now);
      }
      ctx.restore();
    }
  }

  // 铺满后在各赢家锚点处的持续脉冲（维持视觉热度）
  function drawCenterPulse(anchor, color, now) {
    const pulse = 0.5 + 0.5 * Math.sin((now / 800) * Math.PI * 2);
    const r = 50 + pulse * 30;
    const grad = ctx.createRadialGradient(anchor.x, anchor.y, 0, anchor.x, anchor.y, r * 2);
    grad.addColorStop(0, 'rgba(255,255,255,' + (0.35 + 0.25 * pulse) + ')');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, r * 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // 'rgb(r,g,b)' + alpha → 'rgba(r,g,b,a)'
  function colorWithAlpha(rgbStr, alpha) {
    if (!rgbStr) return 'rgba(255,255,255,' + alpha + ')';
    const m = rgbStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (!m) return rgbStr;
    return 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + alpha + ')';
  }

  return {
    init,
    start,
    stop,
    getSize() { return { cssWidth, cssHeight, dpr }; }
  };
}

module.exports = {
  createRenderer,
  SPAWN_DURATION,
  DESPAWN_DURATION
};
