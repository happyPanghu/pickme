// 颜色生成：HSL 色轮程序化，保证相邻色相相距足够远，不会"几个人撞色"
//
// 设计要点：
//   - 用 HSL 而非 RGB：饱和度 / 亮度可精细调控，颜色更鲜艳统一
//   - 记录最近一次色相 _lastHue，新色相必须与上一个相距 ≥ MIN_HUE_DISTANCE（40°）
//   - 如果随机 8 次都太近，就放弃约束，避免死循环（人眼对 40° 色相差已经足够区分）

const MIN_HUE_DISTANCE = 40;
const MAX_HUE_RETRY = 8;

// 饱和度/亮度范围：避开过淡或过暗，保持鲜艳
const SATURATION_MIN = 70;
const SATURATION_MAX = 95;
const LIGHTNESS_MIN = 55;
const LIGHTNESS_MAX = 65;

let _lastHue = -1;

// 计算两个色相之间的最小环形距离（0~180°）
function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
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

function randomColor() {
  let hue = 0;
  for (let i = 0; i < MAX_HUE_RETRY; i++) {
    hue = Math.random() * 360;
    if (_lastHue < 0 || hueDistance(hue, _lastHue) >= MIN_HUE_DISTANCE) break;
  }
  _lastHue = hue;
  const s = SATURATION_MIN + Math.random() * (SATURATION_MAX - SATURATION_MIN);
  const l = LIGHTNESS_MIN + Math.random() * (LIGHTNESS_MAX - LIGHTNESS_MIN);
  return hslToRgbString(hue, s, l);
}

// 重置"上次色相"记忆。新一局开始时调用，让第一根手指的颜色不受上一局最后一根颜色限制。
function resetColorMemory() {
  _lastHue = -1;
}

module.exports = {
  randomColor,
  resetColorMemory
};
