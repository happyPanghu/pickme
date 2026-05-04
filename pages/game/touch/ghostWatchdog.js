// 幽灵手指清理：处理 iOS/微信小程序的 touchend 事件偶发丢失问题
//
// 背景：
//   小程序 onTouchEnd 在部分场景（尤其是快速点击 + 系统高负载）会完全不派发。
//   此时 Map 里会残留"其实已经抬起但状态还是 alive"的幽灵 finger，
//   画面上圆圈永远不消失。必须有独立的清理机制。
//
// 用户红线（绝不允许违反）：
//   "第 6 指加入不生效时，也不能把前面玩家的状态清除"
//   即：任何误杀真手指的行为都是不可接受的。
//
// 方案：lastMissAt 累计"未提及证据"
//   每根 finger 记录 lastMissAt：
//     = 0   当前无 miss 证据在累计（刚被提及 / 刚创建）
//     > 0   最近一次开始连续未被提及的起点时间戳
//
//   两条维护规则（由 reconcileMiss 管）：
//     1. allTouches 事件可信 + 含该 id → 清零（f.lastMissAt = 0）
//     2. allTouches 事件可信 + 不含该 id → 若 lastMissAt=0 则置 now 开始计时；否则保留继续累计
//     3. 事件不可信（第 6 指截断嫌疑）→ 什么都不做，整个事件跳过
//     4. 没有任何 touch 事件（按住不动）→ reconcileMiss 根本不会被调用 → lastMissAt 不变
//
//   清理判定（由 sweep 在 render 每帧调用）：
//     lastMissAt > 0 && now - lastMissAt >= MISS_THRESHOLD_MS → 标为 despawning
//
// 第 6 指截断判定：
//   iOS/微信 allTouches 最多返回 5 根。当 allTouches.length >= 5
//   且 Map 里 active finger 数 >= allTouches.length 时，**无法分辨**：
//     - 真的只有 5 根在屏（合法）
//     - 还有更多手指但被系统截到 5（截断）
//   保守起见：这种事件整次不产出 miss 证据，保住前 5 根真手指。
//
// 三个场景的严格保证：
//   场景 A：按住不动 → 无 touch 事件 → lastMissAt 不变 → 不会触发清理 ✅
//   场景 B：第 6 指截断 → 事件标记不可信 → 前 5 根 lastMissAt 不动 ✅
//   场景 C：touchend 丢失 → 其他手指的 touchmove/touchend 会把它排除在 allTouches 外
//           → lastMissAt 累计 → MISS_THRESHOLD_MS 后清理 ✅

const MISS_THRESHOLD_MS = 1500;

// 第 6 指截断保护：allTouches.length 达到 IOS_MAX_TOUCHES 时进入保护模式
const IOS_MAX_TOUCHES = 5;

function createGhostWatchdog(store, opts) {
  const onGhostRemoved = (opts && opts.onGhostRemoved) || function () {};

  return {
    // 每次系统派发 touch 事件后调用：把 allTouches 作为"证据"去刷新每根 finger 的 lastMissAt。
    // 不考虑 changedTouches（抬起的手指会由 touchHandler 直接标 despawning，不需要走这里）。
    reconcileMiss(allTouches, now) {
      const touches = allTouches || [];

      // 第 6 指截断保护
      const activeCount = store.activeCount();
      const suspectTruncated =
        touches.length >= IOS_MAX_TOUCHES &&
        activeCount >= touches.length;
      if (suspectTruncated) {
        // 这次事件不产出证据，保留所有 finger.lastMissAt 原样
        return { skipped: true, reason: 'truncated', activeCount, touchesLen: touches.length };
      }

      // 提取本次事件里系统确实提及的 id 集合
      const presentIds = new Set();
      for (let i = 0; i < touches.length; i++) {
        presentIds.add(touches[i].identifier);
      }

      const newlyMissed = [];
      const cleared = [];
      store.forEach((f) => {
        if (f.state !== 'spawning' && f.state !== 'alive') return;
        if (presentIds.has(f.id)) {
          // 被明确提及 → 清零 miss 计时
          if (f.lastMissAt !== 0) {
            f.lastMissAt = 0;
            cleared.push(f.id);
          }
        } else {
          // 未被提及 + 事件可信 → 开始或继续累计
          if (f.lastMissAt === 0) {
            f.lastMissAt = now;
            newlyMissed.push(f.id);
          }
          // 已有 lastMissAt 则保持不变（don't reset to now，要累计）
        }
      });

      return { skipped: false, newlyMissed, cleared };
    },

    // render 每帧调用：扫描并清理已累计到阈值的幽灵
    // 返回：被清理的 id 列表
    sweep(now) {
      const ghosts = [];
      store.forEach((f) => {
        if (f.state !== 'spawning' && f.state !== 'alive') return;
        if (typeof f.lastMissAt !== 'number' || f.lastMissAt === 0) return;
        const missMs = now - f.lastMissAt;
        if (missMs >= MISS_THRESHOLD_MS) {
          ghosts.push({ id: f.id, missMs });
        }
      });
      if (ghosts.length === 0) return [];

      // 统一在外面再调用 markDespawning，避免 forEach 过程中改 state 产生副作用
      const removedIds = [];
      for (let i = 0; i < ghosts.length; i++) {
        const ok = store.markDespawning(ghosts[i].id, now);
        if (ok) removedIds.push(ghosts[i].id);
      }
      if (removedIds.length > 0) {
        onGhostRemoved(removedIds);
      }
      return removedIds;
    },

    getThreshold() { return MISS_THRESHOLD_MS; }
  };
}

module.exports = {
  createGhostWatchdog,
  MISS_THRESHOLD_MS,
  IOS_MAX_TOUCHES
};
