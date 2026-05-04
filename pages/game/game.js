// pages/game/game.js
// 页面入口：把各层模块组装起来，只负责"编排 + 游戏规则（倒计时/结算节奏）"
//
// 分层：
//   core/fingerStore       ← 状态机 + 活性账本
//   core/colorPalette      ← 颜色
//   core/winnerStrategy    ← 赢家选择（组队扩展点）
//   core/voronoi           ← 铺屏几何
//   touch/touchHandler     ← 触摸事件分发
//   touch/ghostWatchdog    ← 幽灵手指清理
//   render/canvasRenderer  ← Canvas 绘制
//   feedback/haptic        ← 震动
//   feedback/audio         ← 音效
//   feedback/flash         ← HUD 闪烁

const { createStore } = require('./core/fingerStore.js');
const { RandomStrategy } = require('./core/winnerStrategy.js');
const { createGhostWatchdog } = require('./touch/ghostWatchdog.js');
const { createTouchHandler } = require('./touch/touchHandler.js');
const { createRenderer } = require('./render/canvasRenderer.js');
const { createHaptic } = require('./feedback/haptic.js');
const { createAudio } = require('./feedback/audio.js');
const { createFlashController } = require('./feedback/flash.js');

// 游戏规则参数
const MIN_PLAYERS = 2;
// 倒计时总时长：4s（前 3s 正常呼吸，最后 1s 抉择阶段闪烁）
const COUNTDOWN_MS = 4000;
// 抉择阶段：倒计时剩余 ≤ SHOWDOWN_MS 时进入。
const SHOWDOWN_MS = 1000;
// 抉择候选固定 2 人（规则：不管赢家数多少，视觉统一）
const SHOWDOWN_CANDIDATES = 2;
// 胜利音提前量：倒计时剩余 ≤ 该毫秒数时预播胜利音，让音效比视觉揭晓早一点响起。
// 注意：这个值独立于 SHOWDOWN_MS，改这个只动音效节奏，不改视觉闪烁的时间窗。
const VICTORY_AUDIO_LEAD_MS = 500;
const VICTORY_HOLD_MS = 1000;
const FLOOD_DURATION_MS = 700;
// 铺屏完成后停留时长：给玩家看清赢家的短暂喘息，然后自动回到初始黑色画面。
// 如果用户等不及，在这期间按下手指也能立即重开（走 gameEnded 路径）。
const POST_FLOOD_HOLD_MS = 1000;

Page({
  data: {
    // UI 绑定
    winnerCount: 1,
    touchCount: 0,
    minPlayers: MIN_PLAYERS,
    countingDown: false,
    flooding: false,
    floodColor: '#000',
    flashing: false,
    // 顶部提示：文案 + 情绪样式 class
    hintText: '把手指放上来',
    hintMood: 'calm'
  },

  // ---------------- 生命周期 ----------------
  onLoad() {
    // 1. 核心状态
    this.store = createStore();
    this.strategy = RandomStrategy();

    // 2. 幽灵 watchdog
    // 注意：watchdog 清理出来的活跃数变化语义等同于"抬手"（delta<0），
    //       所以这里统一传 delta=-ids.length，让 _onActiveCountMaybeChanged 走"减少"分支。
    this.watchdog = createGhostWatchdog(this.store, {
      onGhostRemoved: (ids) => this._onActiveCountMaybeChanged('ghost-swept', { delta: -ids.length })
    });

    // 3. 渲染器依赖 getter（每帧都取最新）
    this._stage = 'idle';                // 'idle' | 'showdown' | 'victory' | 'flooding'
    this._victoryStartedAt = 0;
    this._floodStartedAt = 0;
    this._showdownStartedAt = 0;
    this._duelIds = new Set();           // showdown 期间锁定的 2 个候选 id
    this._groups = [];
    this._countdownStartedAt = 0;        // 0 表示没有倒计时在跑

    this.renderer = createRenderer({
      store: this.store,
      watchdog: this.watchdog,
      getStage: () => this._stage,
      getCountdownRemaining: () => this._getCountdownRemaining(),
      getVictoryStartedAt: () => this._victoryStartedAt,
      getFloodStartedAt: () => this._floodStartedAt,
      getShowdownStartedAt: () => this._showdownStartedAt,
      getGroups: () => this._groups
    });

    // 4. 反馈
    this.haptic = createHaptic();
    this.audio = createAudio();
    this.flash = createFlashController((v) => {
      if (this.data.flashing !== v) this.setData({ flashing: v });
    });

    // 5. 触摸分发
    this.touch = createTouchHandler({
      store: this.store,
      watchdog: this.watchdog,
      hooks: {
        onFingerAdded: () => {
          // 按下仅震动；音效已改为统一的胜利/倒计时音，由 _startCountdown/_enterVictory 驱动
          this.haptic.light();
        },
        onFingerRemoved: () => {
          // 抬手不震不响
        },
        onActiveCountChanged: () => this._onActiveCountMaybeChanged('touch-event'),
        onGameShouldReset: () => this._resetGame()
      }
    });
  },

  onReady() {
    this.renderer.init(this).then(() => {
      this.renderer.start();
    }).catch((err) => {
      console.error('[game] renderer init failed:', err);
    });
  },

  onUnload() {
    this._clearCountdown();
    if (this.renderer) this.renderer.stop();
    if (this.audio) this.audio.destroy();
  },

  // ---------------- WXML 事件入口 ----------------
  onTouchStart(e) { this.touch.onTouchStart(e); },
  onTouchMove(e)  { this.touch.onTouchMove(e); },
  onTouchEnd(e)   { this.touch.onTouchEnd(e); },
  onTouchCancel(e){ this.touch.onTouchCancel(e); },

  noop() { /* 吃掉控件区的触摸事件，避免冒泡到 stage */ },

  onIncTouch() { /* 不在按钮上生成圆，仅吃事件 */ },
  onDecTouch() { /* 同上 */ },

  onIncWinner() {
    if (this._stage !== 'idle') return; // 结算中不允许改
    this.setData({ winnerCount: this.data.winnerCount + 1 });
    this.haptic.light();
  },
  onDecWinner() {
    if (this._stage !== 'idle') return;
    if (this.data.winnerCount <= 1) return;
    this.setData({ winnerCount: this.data.winnerCount - 1 });
    this.haptic.light();
  },

  // ---------------- 倒计时 / 结算 编排 ----------------

  // 活跃手指数可能变化时被调用（touch事件 / watchdog 清理后）
  // 唯一会驱动：开始/重置/取消倒计时 + 更新 UI 上的 touchCount 显示
  _onActiveCountMaybeChanged(reason, extra) {
    // showdown / victory / flooding 阶段：候选已锁定，任何触摸变化都不重置倒计时
    // 只刷新 touchCount 显示即可（虽然用户按下新指也会被忽略于游戏逻辑）
    if (this._stage === 'showdown' ||
        this._stage === 'flooding' ||
        this._stage === 'victory') {
      this.setData({ touchCount: this.store.activeCount() });
      return;
    }

    const count = this.store.activeCount();
    this.setData({ touchCount: count });

    if (count < MIN_PLAYERS) {
      // 手指不够，取消倒计时
      this._clearCountdown();
      this._refreshHint();
      return;
    }

    // 手指数 ≥ MIN_PLAYERS：
    //   - 新增 / 初次达标 → 重置倒计时从头开始
    //   - 减少但仍 ≥ 2   → 倒计时继续，不重置（保留已经过去的进度，玩家体验好）
    //
    // 音效规则（用户明确要求）：任何"玩家加入或退出"都要重新播放胜利音。
    //   - 新增分支：_startCountdown 内部已经 play() 过，不用额外播
    //   - 减少但仍满员分支：倒计时没重置，但音效必须重播 → 这里单独调一次 play()
    if (extra && typeof extra.delta === 'number' && extra.delta < 0) {
      if (this._countdownStartedAt === 0) {
        // 退出后又满员（理论上只有 watchdog 扫出来的边缘情况），走重置路径
        this._startCountdown();
      } else {
        // 倒计时进度保留，但倒计时音从头重播（用户要求：进出都重播）
        this.audio.playCountdown();
        this._refreshHint();
      }
      return;
    }
    // 新增 或 watchdog 触发的变化 或 初次达标 → 重置倒计时（_startCountdown 内会 play）
    this._startCountdown();
  },

  _startCountdown() {
    this._clearCountdown();
    this._countdownStartedAt = Date.now();
    this.setData({ countingDown: true });
    this._refreshHint();
    // 倒计时音完全跟随倒计时生命周期：这里启动就从头播
    this.audio.playCountdown();
    // 标志位：本轮倒计时是否已经预播过胜利音。_clearCountdown / _resetGame 会重置。
    this._victoryAudioPlayed = false;

    // 用一个轻量的 interval 更新 flash 状态 + 提示文案 + 阶段推进
    this._countdownTimer = setInterval(() => {
      const remaining = this._getCountdownRemaining();
      this.flash.setRemaining(remaining);
      // 倒计时中文案分三档（steady / tense / urgent），这里每 tick 算一次，
      // _refreshHint 内部有差量比较，相同值不会触发 setData，不会有性能问题
      this._refreshHint();

      // 倒计时剩余 ≤ SHOWDOWN_MS 且还在 idle → 切到抉择阶段（视觉：2 人 ping-pong）
      if (this._stage === 'idle' && remaining <= SHOWDOWN_MS) {
        this._enterShowdown();
      }

      // 倒计时剩余 ≤ VICTORY_AUDIO_LEAD_MS 且本轮还没播 → 预播胜利音
      // 独立于 showdown 的视觉节奏：视觉在最后 1s 闪烁，音效在最后 0.5s 才响起
      if (!this._victoryAudioPlayed && remaining <= VICTORY_AUDIO_LEAD_MS) {
        this._victoryAudioPlayed = true;
        this.audio.playVictory();
      }

      if (remaining <= 0) {
        // 正常到期结算：此时胜利音一定已经预播了（0.5s 前那个分支先命中），
        // 所以传 keepVictoryAudio=true 让胜利音继续放完
        this._clearCountdown({ keepVictoryAudio: true });
        this._enterVictory();
      }
    }, 50);
  },

  // opts.keepVictoryAudio：
  //   true  → 正常结算路径（interval 走到 0），胜利音要继续放
  //   false → 游戏被中止（人数破线 / onUnload / _resetGame），胜利音要立即停
  _clearCountdown(opts) {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
    this._countdownStartedAt = 0;
    this.flash.stop();
    if (this.data.countingDown) this.setData({ countingDown: false });
    // 倒计时音跟随倒计时状态：倒计时一结束（无论是被取消还是到期），音效立即停
    if (this.audio) this.audio.stopCountdown();
    // 胜利音：只有"被中止"路径需要掐断已经预播的胜利音
    const keep = opts && opts.keepVictoryAudio;
    if (!keep && this._victoryAudioPlayed && this.audio) {
      this.audio.stopVictory();
    }
  },

  // ---------------- 提示文案 ----------------
  // 根据当前 stage + touchCount + 倒计时剩余，算出最合适的一句话 + 情绪样式。
  // 任何状态变化都应该调用 _refreshHint() 刷新它。
  _computeHint() {
    const count = this.store.activeCount();

    if (this._stage === 'flooding') {
      return { text: '按下手指重新开始', mood: 'restart' };
    }
    if (this._stage === 'victory') {
      return { text: '恭喜胜者！', mood: 'winner' };
    }
    // 抉择阶段：独立 mood，和 urgent 共用样式
    if (this._stage === 'showdown') {
      return { text: '抉择时刻！', mood: 'urgent' };
    }

    // idle 阶段（倒计时前 2s）
    if (this._countdownStartedAt > 0) {
      const remaining = this._getCountdownRemaining();
      // 注意：remaining <= SHOWDOWN_MS 会触发进入 showdown 阶段，这里理论上不会再命中 <=1000 分支
      if (remaining <= 2000) return { text: '即将揭晓…',         mood: 'tense' };
      return                        { text: '稳住，命运在翻牌',  mood: 'steady' };
    }

    // 未倒计时
    if (count === 0) return { text: '把手指放上来', mood: 'calm' };
    if (count === 1) return { text: '还差 1 位…',   mood: 'waiting' };
    // count ≥ 2 但还没启动倒计时（理论上会立刻启动，这是极短的过渡态）
    return           { text: '准备好了吗？', mood: 'ready' };
  },

  _refreshHint() {
    const h = this._computeHint();
    // 差量比较避免无意义 setData 触发视图重绘
    if (h.text !== this.data.hintText || h.mood !== this.data.hintMood) {
      this.setData({ hintText: h.text, hintMood: h.mood });
    }
  },

  _getCountdownRemaining() {
    if (!this._countdownStartedAt) return Infinity;
    return Math.max(0, COUNTDOWN_MS - (Date.now() - this._countdownStartedAt));
  },

  // ---------------- showdown / victory / flooding ----------------

  // 进入抉择阶段：从活跃手指里随机挑 2 个候选，其他立即淡出
  _enterShowdown() {
    const active = this.store.activeList();
    if (active.length < MIN_PLAYERS) return; // 人数不够兜底

    // 随机挑 2 个（如果恰好只有 2 人则直接选这 2 个）
    const picked = this._pickRandomK(active, SHOWDOWN_CANDIDATES);
    const duelSet = new Set();
    for (let i = 0; i < picked.length; i++) duelSet.add(picked[i].id);

    // 更新 store 状态：候选 → showdown，其他活跃 → despawning
    const now = Date.now();
    this.store.applyShowdown(duelSet, now);

    this._stage = 'showdown';
    this._showdownStartedAt = now;
    this._duelIds = duelSet;
    // 锁死触摸：showdown 期间用户再按下的新指全部被忽略，候选集不可变
    this.touch.setGameLocked(true);
    this.haptic.medium();
    // 胜利音不在 showdown 入口触发：已改由倒计时 interval 在剩 VICTORY_AUDIO_LEAD_MS 时
    // 独立触发，这样视觉闪烁节奏（1s）和音效提前量（0.5s）可以独立调。
    this._refreshHint();
  },

  // Fisher-Yates 取前 k 个，不改原数组
  _pickRandomK(arr, k) {
    const n = Math.min(k, arr.length);
    const pool = arr.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    return pool.slice(0, n);
  },

  _enterVictory() {
    // 抉择阶段走到这里：候选池 = this._duelIds 锁定的 2 个
    // 无抉择阶段兜底：退回按活跃列表选
    let pool;
    if (this._stage === 'showdown') {
      pool = this.store.showdownList();
    } else {
      pool = this.store.activeList();
    }
    if (pool.length < 1) return;

    // 通过策略层选出 Group 列表（扩展点）
    // 注意：winnerCount 可能大于 pool.length（2），策略内部会 Math.min 处理
    this._groups = this.strategy.pick(pool, { winnerCount: this.data.winnerCount });
    if (!this._groups || this._groups.length === 0) return;

    // 把赢家 id 聚合起来交给 store
    const winnerIds = new Set();
    for (let i = 0; i < this._groups.length; i++) {
      const ws = this._groups[i].winners;
      for (let k = 0; k < ws.length; k++) winnerIds.add(ws[k].id);
    }
    this.store.applyWinners(winnerIds, Date.now());

    this._stage = 'victory';
    this._victoryStartedAt = Date.now();
    this.haptic.heavy();
    // 胜利音已在 _enterShowdown（提前 1s）触发过，这里不再重播，
    // 让它自然放完即可（倒计时音已在 _clearCountdown 里停掉）
    this._refreshHint();

    // 1s 后进入 flooding
    this._victoryTimer = setTimeout(() => this._enterFlooding(), VICTORY_HOLD_MS);
  },

  _enterFlooding() {
    this._stage = 'flooding';
    this._floodStartedAt = Date.now();
    // 铺屏色：单赢家直接用组色；多赢家 UI 背景保持黑，由 canvas 画分区
    const floodColor = this._groups.length === 1 ? this._groups[0].color : '#000';
    this.setData({ flooding: true, floodColor });
    this._refreshHint();
    this.haptic.long();
    // flooding 阶段不再额外触发音效：_enterVictory 刚刚已经 play 过，这里再播会打断自己

    // flooding 动画走完 → 允许用户按下重开（gameEnded），同时排队自动 reset。
    // 两条路径都会走 _resetGame（_resetGame 内部会清掉 _autoResetTimer 避免重复触发）。
    this._floodTimer = setTimeout(() => {
      this._stage = 'flooding'; // 保持在 flooding 画面上
      this.touch.setGameEnded(true);
      // 再停留 POST_FLOOD_HOLD_MS 后自动回到初始黑色画面
      this._autoResetTimer = setTimeout(() => this._resetGame(), POST_FLOOD_HOLD_MS);
    }, FLOOD_DURATION_MS);
  },

  // ---------------- 重开 ----------------

  _resetGame() {
    if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
    if (this._victoryTimer) { clearTimeout(this._victoryTimer); this._victoryTimer = null; }
    if (this._floodTimer) { clearTimeout(this._floodTimer); this._floodTimer = null; }
    // 无论是用户主动按下重开、还是自动 reset 触发，都要清掉 auto-reset timer 避免重复触发
    if (this._autoResetTimer) { clearTimeout(this._autoResetTimer); this._autoResetTimer = null; }

    this.store.reset();

    this._stage = 'idle';
    this._victoryStartedAt = 0;
    this._floodStartedAt = 0;
    this._showdownStartedAt = 0;
    this._duelIds = new Set();
    this._groups = [];
    this._countdownStartedAt = 0;
    this._victoryAudioPlayed = false;

    this.touch.setGameEnded(false);
    this.touch.setGameLocked(false);
    this.flash.stop();

    this.setData({
      touchCount: 0,
      countingDown: false,
      flooding: false,
      floodColor: '#000',
      flashing: false,
      hintText: '把手指放上来',
      hintMood: 'calm'
    });
  }
});
