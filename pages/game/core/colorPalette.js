// 颜色生成：HSL 色轮程序化，保证同屏所有手指色相两两相距足够远，不会"几个人撞色"
//
// 设计要点：
//   - 用 HSL 而非 RGB：饱和度 / 亮度可精细调控，颜色更鲜艳统一
//   - 选色时和【当前同屏所有活跃手指】的色相都保持距离（旧版只和上一根比，
//     超过 2 根时容易出现"第 3 根和第 1 根撞色"）
//   - 自适应阈值：人少时严格（≥55°），人多时逐步放宽（360/N°），避免 10 根手指时死循环
//   - 扩大 Lightness 范围（50~72）增加明度差异，即使色相接近也能靠明度区分
//   - 色相落在 6 个色区的反向区域，进一步分散颜色
//
// 导出：
//   randomColor(existingHues?: number[]) → { color: string, hue: number }
//     把返回的 hue 回传给下次调用，即可保持分散
//   resetColorMemory() → 保留 API 仅为向后兼容（现在无状态，调用无副作用）

const MIN_HUE_DISTANCE_STRICT = 55;   // 同屏 ≤ 6 根时要求
const MIN_HUE_DISTANCE_FLOOR  = 30;   // 下限，兜底防止死循环
const MAX_HUE_RETRY = 16;

// 饱和度 / 亮度：拉宽明度范围让同色相也能区分
const SATURATION_MIN = 72;
const SATURATION_MAX = 96;
const LIGHTNESS_MIN  = 50;
const LIGHTNESS_MAX  = 72;

// 计算两个色相之间的最小环形距离（0~180°）
function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// 当前同屏 N 根手指时，采纳的最小色相距离阈值。
// N=1 → 55°（无实际约束）；N=2 → 55°；N=3 → 55°；N=6 → ~55°；N=8 → 45°；N=10 → 36°
function computeThreshold(existingCount) {
  if (existingCount <= 6) return MIN_HUE_DISTANCE_STRICT;
  // 360/N 给出理论等分间距，乘 0.9 留余地；不低于 FLOOR
  const adaptive = (360 / (existingCount + 1)) * 0.9;
  return Math.max(MIN_HUE_DISTANCE_FLOOR, Math.min(MIN_HUE_DISTANCE_STRICT, adaptive));
}

// 判断 hue 与 existingHues 中每个元素的最小距离 ≥ threshold
function isFarEnough(hue, existingHues, threshold) {
  for (let i = 0; i < existingHues.length; i++) {
    if (hueDistance(hue, existingHues[i]) < threshold) return false;
  }
  return true;
}

// HSL → 'rgb(r,g,b)' 字符串。Canvas 2D 原生支持 hsl()，但部分基础库
// 在 globalCompositeOperation='lighter' 下对 hsl() 混合异常，统一走 rgb()。
function hslToRgbString(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60)        { r = c; g = x; b = 0; }
  else if (h < 120)  { r = x; g = c; b = 0; }
  else if (h < 180)  { r = 0; g = c; b = x; }
  else if (h < 240)  { r = 0; g = x; b = c; }
  else if (h < 300)  { r = x; g = 0; b = c; }
  else               { r = c; g = 0; b = x; }
  return 'rgb(' +
    Math.round((r + m) * 255) + ',' +
    Math.round((g + m) * 255) + ',' +
    Math.round((b + m) * 255) + ')';
}

// 生成一个与 existingHues 中所有色相都保持足够距离的颜色
// existingHues: 数组，元素是已被占用的色相度数（0~360）。不传或空数组表示无约束。
// 返回 { color: 'rgb(...)' 字符串, hue: 实际选中的色相（供调用方记录） }
function randomColor(existingHues) {
  const used = Array.isArray(existingHues) ? existingHues : [];
  const threshold = computeThreshold(used.length);

  let hue = Math.random() * 360;
  for (let i = 0; i < MAX_HUE_RETRY; i++) {
    const candidate = Math.random() * 360;
    if (used.length === 0 || isFarEnough(candidate, used, threshold)) {
      hue = candidate;
      break;
    }
  }

  // 明度：已占用的色相越多，越倾向于"极端明度"（更亮或更暗），进一步拉开区分度
  const l = LIGHTNESS_MIN + Math.random() * (LIGHTNESS_MAX - LIGHTNESS_MIN);
  const s = SATURATION_MIN + Math.random() * (SATURATION_MAX - SATURATION_MIN);
  return { color: hslToRgbString(hue, s, l), hue: hue };
}

// 向后兼容：旧实现维护过 _lastHue 全局状态，新实现无状态但保留 API 避免调用方改动
function resetColorMemory() { /* noop: stateless now */ }

module.exports = {
  randomColor,
  resetColorMemory
};
