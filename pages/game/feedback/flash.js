// 闪烁效果：倒计时最后 1 秒触发底部赢家数控件的"快速闪烁"
//
// 设计：
//   Canvas 里圆的闪烁由 renderer 直接基于 getCountdownRemaining 判断，不走这里。
//   这里只负责"DOM 层"HUD 控件的 flashing 标志位：
//     - setRemaining(ms)：page 每次倒计时 tick 时调用
//     - 当 remaining 跨过 THRESHOLD → onFlashChange(true)  让 WXML 加上 .hud-flashing
//     - 当 remaining > THRESHOLD 或倒计时取消 → onFlashChange(false)

const THRESHOLD = 1000; // 剩余 ≤ 1s 开始闪

function createFlashController(onFlashChange) {
  let lastFlash = false;

  function _set(v) {
    if (v === lastFlash) return;
    lastFlash = v;
    if (onFlashChange) onFlashChange(v);
  }

  return {
    setRemaining(ms) {
      if (typeof ms !== 'number' || ms <= 0) {
        _set(false);
        return;
      }
      _set(ms <= THRESHOLD);
    },
    stop() { _set(false); },
    getThreshold() { return THRESHOLD; },
    isFlashing() { return lastFlash; }
  };
}

module.exports = {
  createFlashController,
  FLASH_THRESHOLD: THRESHOLD
};
