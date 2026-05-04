// 赢家选择策略：面向"组队"扩展的接口层。
//
// 接口：
//   strategy.pick(activeFingers, ctx) -> Group[]
//
// Group 结构：
//   {
//     winners: Finger[],   该组的赢家手指列表（组内共享 color）
//     color: string        该组的代表色，用于 flooding 阶段绘制
//   }
//
// 铺屏阶段按 Group 数组绘制 Voronoi：每组占据 Voronoi 图中距离本组"锚点"最近的那块区域。
// 锚点 = group.winners 的几何中心（单人组就是该手指本身位置）。
//
// 当前实现：
//   - RandomStrategy：Fisher-Yates 洗牌，取前 winnerCount 个 → 每人一组（各用自己的颜色）
//
// 未来扩展示例（无需改任何其他层）：
//   - TeamStrategy(2)：按位置 K-Means 聚成 2 队 → 2 个 Group，各组用一种代表色
//   - ManualTeamStrategy：玩家手动拖动组队 → 外部指定分组后这里直接返回

// Fisher-Yates 洗牌（返回新数组，不改原数组）
function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ---- RandomStrategy ----
// ctx 里需要提供 winnerCount（用户在 UI 设的赢家数）
function RandomStrategy() {
  return {
    name: 'random',
    pick(activeFingers, ctx) {
      if (!activeFingers || activeFingers.length === 0) return [];
      const n = Math.min(ctx.winnerCount || 1, activeFingers.length);
      const pool = shuffle(activeFingers);
      const chosen = pool.slice(0, n);
      // 每个赢家一个组，用各自颜色
      return chosen.map((f) => ({
        winners: [f],
        color: f.color
      }));
    }
  };
}

// ---- Group 的锚点坐标：组的几何中心 ----
// 铺屏时每组按自己的锚点去计算 Voronoi 分区
function groupAnchor(group) {
  const n = group.winners.length;
  if (n === 1) return { x: group.winners[0].x, y: group.winners[0].y };
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += group.winners[i].x;
    sy += group.winners[i].y;
  }
  return { x: sx / n, y: sy / n };
}

module.exports = {
  RandomStrategy,
  groupAnchor
};
