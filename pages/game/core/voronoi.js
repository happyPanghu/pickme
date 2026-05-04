// Voronoi 半平面裁剪：
// 给定 N 个锚点，把屏幕矩形逐个用"到本锚点 ≤ 到其他锚点"的半平面裁剪，
// 最终每个锚点得到一个凸多边形（= 该锚点的 Voronoi 单元，即屏幕上离它最近的那块区域）。
//
// 算法：Sutherland-Hodgman 多边形裁剪
// 复杂度：O(N² × 边数)，N 通常 ≤ 10，完全够用
//
// 注意：所有坐标均为 CSS px（不含 dpr）。Canvas 绘制前由 renderer 乘以 dpr。

// 用一条直线（由 a → b → c 的垂直平分线方向决定）把 poly 裁剪，保留"更靠近 a 端"的半平面。
// 即：保留所有满足 "到 a 的距离 ≤ 到 b 的距离" 的点。
// 半平面的不等式：(p - m) · (b - a) ≤ 0，其中 m = (a+b)/2
function clipByBisector(poly, ax, ay, bx, by) {
  if (!poly || poly.length === 0) return [];

  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const nx = bx - ax;   // 法向量指向 b；"更靠近 a"⇔ (p - m) · n ≤ 0
  const ny = by - ay;

  const sideOf = (p) => (p.x - mx) * nx + (p.y - my) * ny;

  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const sCur = sideOf(cur);
    const sPrev = sideOf(prev);

    if (sPrev <= 0) {
      // prev 在保留侧
      if (sCur <= 0) {
        // cur 也在保留侧：直接收 cur
        out.push(cur);
      } else {
        // prev 在保留侧，cur 不在：收交点
        const t = sPrev / (sPrev - sCur);
        out.push({
          x: prev.x + t * (cur.x - prev.x),
          y: prev.y + t * (cur.y - prev.y)
        });
      }
    } else {
      // prev 不在保留侧
      if (sCur <= 0) {
        // prev 出，cur 进：先收交点，再收 cur
        const t = sPrev / (sPrev - sCur);
        out.push({
          x: prev.x + t * (cur.x - prev.x),
          y: prev.y + t * (cur.y - prev.y)
        });
        out.push(cur);
      }
      // 都不在保留侧：不收
    }
  }
  return out;
}

// 为 anchors[i] 计算它在屏幕矩形内的 Voronoi 单元（凸多边形）
// 返回：[{x,y}, ...] 顶点数组，或空数组表示退化
function cellFor(anchors, i, screenWidth, screenHeight) {
  let poly = [
    { x: 0,           y: 0 },
    { x: screenWidth, y: 0 },
    { x: screenWidth, y: screenHeight },
    { x: 0,           y: screenHeight }
  ];
  const a = anchors[i];
  for (let j = 0; j < anchors.length; j++) {
    if (i === j) continue;
    const b = anchors[j];
    poly = clipByBisector(poly, a.x, a.y, b.x, b.y);
    if (poly.length === 0) break;
  }
  return poly;
}

module.exports = {
  cellFor
};
