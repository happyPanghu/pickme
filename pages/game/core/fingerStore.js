// 手指状态仓库：集中管理所有手指的生命周期 + 活性账本
//
// 状态机（严格）：
//   spawning ── 出现动画期间（0 ~ SPAWN_DURATION）
//      │
//      ▼
//     alive ── 正常按住期间（呼吸动画）
//      │
//      ├──→ showdown ── 倒计时最后 1 秒，被选中的 2 名候选进入高频 ping-pong 闪烁
//      │         │           其他未被选中的手指这一刻全部转为 despawning
//      │         ▼
//      │      victory ── showdown 结束，从候选中挑出最终赢家
//      │
//      ├──→ despawning ── 抬手后淡出（0 ~ DESPAWN_DURATION），动画结束则 delete
//      │
//      └──→ victory ── 结算选中赢家时进入；flooding 时由 resetGame 统一清
//
// 活性账本（用于幽灵 watchdog）：
//   lastMissAt: 语义严格——
//     = 0   当前没有"未被提及"的证据在累计中（刚被提及 / 刚创建）
//     > 0   最近一次开始连续未被提及的时间戳
//   这个字段只能由 ghostWatchdog 的 reconcileMiss 维护，其他代码绝不能直接改。
//
// 字段：
//   id          系统 touch identifier
//   x, y        CSS px 坐标（不含 dpr）
//   color       HSL 生成的 rgb 字符串
//   sizeScale   [0.8, 1.0] 随机尺寸系数，画面更有灵气
//   createdAt   创建/刷新时间戳
//   state       见上文状态机
//   removedAt   进入 despawning 的时间戳，用于计算淡出进度
//   lastMissAt  见上文活性账本

const { randomColor, resetColorMemory } = require('./colorPalette.js');

const SIZE_SCALE_MIN = 0.8;
const SIZE_SCALE_MAX = 1.0;

function randomSizeScale() {
  return SIZE_SCALE_MIN + Math.random() * (SIZE_SCALE_MAX - SIZE_SCALE_MIN);
}

function createStore() {
  // 用闭包封装，避免多页面场景下全局污染
  const fingers = new Map();

  return {
    // ------- 只读查询 -------
    getMap() { return fingers; },
    size() { return fingers.size; },
    has(id) { return fingers.has(id); },
    get(id) { return fingers.get(id); },
    forEach(fn) { fingers.forEach(fn); },

    // 统计处于活跃状态（spawning / alive）的手指数。despawning / victory / showdown 不计入。
    activeCount() {
      let c = 0;
      fingers.forEach((f) => {
        if (f.state === 'spawning' || f.state === 'alive') c++;
      });
      return c;
    },

    activeList() {
      const out = [];
      fingers.forEach((f) => {
        if (f.state === 'spawning' || f.state === 'alive') out.push(f);
      });
      return out;
    },

    // 返回所有处于 showdown 的候选（m+1 个，m 为赢家数），按稳定排序保证 ping-pong 反相一致
    showdownList() {
      const out = [];
      fingers.forEach((f) => {
        if (f.state === 'showdown') out.push(f);
      });
      // id 升序稳定排序：renderer 用 index 决定 A/B 反相相位，排序能保证每帧一致
      out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return out;
    },

    // ------- 写入 -------

    // 收集【当前同屏所有未抬手的手指】的色相，用于新指选色时避让
    // despawning 的手指 0.3s 内还在淡出画面上，也要避让避免撞色
    // 刷新某个 id 时，排除自己的旧色相（下面 addOrRefresh 会 pass selfId）
    _collectExistingHues(selfId) {
      const out = [];
      fingers.forEach((f) => {
        if (f.id === selfId) return;
        // victory / flooding 阶段的圆已经无所谓色相了（要么马上被放大强调，要么铺屏已盖住）
        if (f.state === 'idle' || f.state === 'victory' || f.state === 'flooding') return;
        if (typeof f.hue === 'number') out.push(f.hue);
      });
      return out;
    },

    // 新按下一根手指。如果 id 已存在（系统偶发复用），原地刷新而非新建。
    // 返回值：{ added: boolean, finger }
    // added=true 表示新增；false 表示 id 已存在被刷新
    addOrRefresh(id, x, y, now) {
      const existed = fingers.get(id);
      if (existed) {
        const picked = randomColor(this._collectExistingHues(id));
        existed.x = x;
        existed.y = y;
        existed.color = picked.color;
        existed.hue = picked.hue;
        existed.sizeScale = randomSizeScale();
        existed.createdAt = now;
        existed.state = 'spawning';
        existed.removedAt = 0;
        existed.lastMissAt = 0;
        return { added: false, finger: existed };
      }
      const picked = randomColor(this._collectExistingHues(id));
      const f = {
        id,
        x,
        y,
        color: picked.color,
        hue: picked.hue,
        sizeScale: randomSizeScale(),
        createdAt: now,
        state: 'spawning',
        removedAt: 0,
        lastMissAt: 0
      };
      fingers.set(id, f);
      return { added: true, finger: f };
    },

    // 更新活跃手指的坐标（touchmove 用）
    updatePos(id, x, y) {
      const f = fingers.get(id);
      if (!f) return;
      if (f.state === 'spawning' || f.state === 'alive') {
        if (typeof x === 'number') f.x = x;
        if (typeof y === 'number') f.y = y;
      }
    },

    // 标记进入退场动画。重复调用幂等（已 despawning / victory / showdown 的不变）。
    markDespawning(id, now) {
      const f = fingers.get(id);
      if (!f) return false;
      if (f.state === 'despawning' || f.state === 'victory' || f.state === 'showdown') return false;
      f.state = 'despawning';
      f.removedAt = now;
      return true;
    },

    // 抉择阶段：把指定 id 集合里的手指标记为 showdown 候选，
    // 其他活跃手指立即转 despawning 快速淡出。
    // candidateIds 是 Set<id>，大小为 m+1（m 为赢家数）；n ≤ m+1 时等于 n（兜底，全员入场）。
    applyShowdown(candidateIds, now) {
      fingers.forEach((f) => {
        if (f.state !== 'spawning' && f.state !== 'alive') return;
        if (candidateIds.has(f.id)) {
          f.state = 'showdown';
          f.showdownStartedAt = now;
        } else {
          f.state = 'despawning';
          f.removedAt = now;
        }
      });
    },

    // spawning → alive 的状态推进（由 renderer 在动画到顶时调用）
    promoteToAlive(id) {
      const f = fingers.get(id);
      if (f && f.state === 'spawning') f.state = 'alive';
    },

    // 从 Map 中彻底移除（退场动画完成后由 renderer 调用）
    remove(id) {
      fingers.delete(id);
    },

    // pickWinners 后标记赢家为 victory 状态，其他全部 despawning
    // 兼容从 showdown → victory：showdown 候选中的赢家直接转 victory，非赢家转 despawning
    applyWinners(winnerIdSet, now) {
      fingers.forEach((f) => {
        if (winnerIdSet.has(f.id)) {
          f.state = 'victory';
        } else if (f.state !== 'despawning') {
          f.state = 'despawning';
          f.removedAt = now;
        }
      });
    },

    // 新一局开始：整体重建，确保不残留任何旧状态
    reset() {
      fingers.clear();
      resetColorMemory();
    },

    // 调试用：导出所有 finger 的摘要
    dump() {
      const list = [];
      const now = Date.now();
      fingers.forEach((f) => {
        list.push({
          id: f.id,
          state: f.state,
          age: now - f.createdAt,
          sinceRemove: f.removedAt ? now - f.removedAt : 0,
          lastMiss: f.lastMissAt ? now - f.lastMissAt : 0
        });
      });
      return list;
    }
  };
}

module.exports = {
  createStore
};
