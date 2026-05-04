// 触摸事件分发：统一处理 touchstart/touchmove/touchend/touchcancel
//
// 职责：
//   1. 解析微信 touch 事件里的坐标（兼容 x/y 在部分基础库为 undefined 的情况）
//   2. 把 changed/allTouches 事件翻译成 fingerStore 的操作（add / updatePos / markDespawning）
//   3. 每次事件结束后调用 ghostWatchdog.reconcileMiss 更新 miss 证据
//   4. 通过回调把业务信号（first-add / last-remove / count-change）抛给 page
//
// 不负责：
//   - 游戏规则判定（倒计时、胜者选择）→ 在 page 层
//   - 渲染 → 在 canvasRenderer
//   - 状态机内部细节 → 在 fingerStore

// 坐标兼容：部分基础库下 touch.x 为 undefined，退回 clientX
function pickCoord(t, key) {
  if (typeof t[key] === 'number') return t[key];
  const alt = key === 'x' ? 'clientX' : 'clientY';
  if (typeof t[alt] === 'number') return t[alt];
  const alt2 = key === 'x' ? 'pageX' : 'pageY';
  if (typeof t[alt2] === 'number') return t[alt2];
  return undefined;
}

function createTouchHandler(deps) {
  const store = deps.store;
  const watchdog = deps.watchdog;
  const hooks = deps.hooks || {};

  // 回调（全部可选）：
  //   onFingerAdded(finger, context)        每次新指被 add 时触发（已经 refresh 的不算）
  //   onFingerRemoved(id, context)          每次手指进入 despawning 时触发
  //   onActiveCountChanged(count, context)  活跃手指数变化（spawning+alive）
  //   onGameShouldReset(context)            当前是 gameEnded 状态被新 touchstart 打断时
  const onFingerAdded = hooks.onFingerAdded || function () {};
  const onFingerRemoved = hooks.onFingerRemoved || function () {};
  const onActiveCountChanged = hooks.onActiveCountChanged || function () {};
  const onGameShouldReset = hooks.onGameShouldReset || function () {};

  // 由 page 层设置：
  //   gameEnded  → "游戏已结束、下次 touchstart 应该先 reset"（flooding 完成后开启）
  //   gameLocked → "showdown/victory 阶段，候选已锁定，不允许任何 touchstart 产生新指"
  //                （touchend/touchmove 仍然正常，避免 Map 里遗留数据）
  let gameEnded = false;
  let gameLocked = false;

  function onTouchStart(e) {
    const now = Date.now();
    const changed = e.changedTouches || [];
    const allTouches = e.touches || [];

    // gameEnded 状态下，任意 touchstart 直接触发重开，不参与本局手指管理
    if (gameEnded) {
      onGameShouldReset({ now, source: 'touchstart' });
      // reset 后本次事件仍然作为"第一指"加入新局
      // 注意：_resetGame 里会调用 setGameLocked(false)，所以下面的 gameLocked 分支不会误伤
    }

    // gameLocked 状态下（showdown/victory）：候选已锁定，新指全部忽略
    // 但仍然需要喂 watchdog（否则前面的 lastMissAt 累计可能被 miss）
    if (gameLocked) {
      watchdog.reconcileMiss(allTouches, now);
      return;
    }

    const prevActive = store.activeCount();
    let addedCount = 0;

    for (let i = 0; i < changed.length; i++) {
      const t = changed[i];
      const x = pickCoord(t, 'x');
      const y = pickCoord(t, 'y');
      if (typeof x !== 'number' || typeof y !== 'number') {
        // 坐标异常，跳过
        continue;
      }
      const result = store.addOrRefresh(t.identifier, x, y, now);
      if (result.added) {
        addedCount++;
        onFingerAdded(result.finger, { now });
      }
    }

    // 此时新指已入 Map，喂 watchdog 更新 miss 证据
    watchdog.reconcileMiss(allTouches, now);

    const curActive = store.activeCount();
    if (curActive !== prevActive) {
      onActiveCountChanged(curActive, { now, delta: curActive - prevActive, added: addedCount });
    }
  }

  function onTouchMove(e) {
    if (gameEnded) return;
    const now = Date.now();
    const touches = e.touches || [];
    for (let i = 0; i < touches.length; i++) {
      const t = touches[i];
      const x = pickCoord(t, 'x');
      const y = pickCoord(t, 'y');
      store.updatePos(t.identifier, x, y);
    }
    watchdog.reconcileMiss(touches, now);
  }

  function onTouchEnd(e) {
    handleRemove(e, 'touchend');
  }

  function onTouchCancel(e) {
    handleRemove(e, 'touchcancel');
  }

  function handleRemove(e, source) {
    const now = Date.now();
    const changed = e.changedTouches || [];
    const allTouches = e.touches || [];

    const prevActive = store.activeCount();
    let removedCount = 0;
    for (let i = 0; i < changed.length; i++) {
      const id = changed[i].identifier;
      if (store.markDespawning(id, now)) {
        removedCount++;
        onFingerRemoved(id, { now, source });
      }
    }

    // 此时 changed 里的已经是 despawning，reconcileMiss 会自动跳过 despawning，
    // 只对"真正还在屏的 active finger"累计证据
    watchdog.reconcileMiss(allTouches, now);

    const curActive = store.activeCount();
    if (curActive !== prevActive) {
      onActiveCountChanged(curActive, { now, delta: curActive - prevActive, removed: removedCount });
    }
  }

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    setGameEnded(v) { gameEnded = !!v; },
    isGameEnded() { return gameEnded; },
    setGameLocked(v) { gameLocked = !!v; },
    isGameLocked() { return gameLocked; }
  };
}

module.exports = {
  createTouchHandler
};
