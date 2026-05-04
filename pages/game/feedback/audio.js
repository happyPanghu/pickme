// 音效服务（双角色）：
//
// 业务规则（由 game.js 调用）：
//   1. 倒计时音（2063）：完全跟随倒计时的生命周期
//        - 倒计时启动 / 玩家加入 / 玩家退出（仍满员）→ playCountdown() 从头重播
//        - 倒计时取消（人数破线）/ 倒计时到期 / 进入胜利  → stopCountdown() 立即停
//   2. 胜利音（231）：决出胜者时 playVictory() 从头播一次
//
// 这两条通道互相独立，各用一个 InnerAudioContext 实例。
// 切换时互不打断对方（例如胜利音触发时，倒计时音由 game.js 显式 stopCountdown 掐掉）。
//
// 失败处理：onError 打 warn，不抛出，文件缺失时游戏继续能玩。

const COUNTDOWN_SRC = '/assets/audio/classic/mixkit-arcade-rising-231.wav';
const VICTORY_SRC   = '/assets/audio/classic/mixkit-completion-of-a-level-2063.wav';

function _createCtx(src, volume, label) {
  let ctx = null;
  try {
    ctx = wx.createInnerAudioContext({ useWebAudioImplement: false });
    ctx.src = src;
    ctx.volume = typeof volume === 'number' ? volume : 1;
    ctx.loop = false;
    ctx.autoplay = false;
    ctx.onError((err) => {
      console.warn('[audio][' + label + '] error:', err);
    });
  } catch (e) {
    console.warn('[audio][' + label + '] create failed:', e);
    ctx = null;
  }
  return ctx;
}

function createAudio() {
  const countdownCtx = _createCtx(COUNTDOWN_SRC, 1.0, 'countdown');
  const victoryCtx   = _createCtx(VICTORY_SRC,   1.0, 'victory');

  // 通用的"从头重播"：stop + seek(0) + play 三连
  function _restart(ctx, label) {
    if (!ctx) return;
    try {
      ctx.stop();
      ctx.seek(0);
      ctx.play();
    } catch (e) {
      console.warn('[audio][' + label + '] play failed:', e);
    }
  }
  function _stop(ctx) {
    if (!ctx) return;
    try { ctx.stop(); } catch (_) { /* noop */ }
  }

  return {
    // 倒计时音（2063）
    playCountdown() { _restart(countdownCtx, 'countdown'); },
    stopCountdown() { _stop(countdownCtx); },
    // 胜利音（231）
    playVictory()   { _restart(victoryCtx, 'victory'); },
    stopVictory()   { _stop(victoryCtx); },
    destroy() {
      try { if (countdownCtx) countdownCtx.destroy(); } catch (_) { /* noop */ }
      try { if (victoryCtx)   victoryCtx.destroy();   } catch (_) { /* noop */ }
    }
  };
}

module.exports = {
  createAudio
};
