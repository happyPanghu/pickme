// 音效服务（简化版）：
//
// 业务规则（由 game.js 调用）：
//   1. 倒计时启动 / 玩家加入 / 玩家退出 → 调 play()：从头重播一次
//   2. 决出胜利 → 调 play()：同样从头重播一次（会打断倒计时阶段正在放的那次）
//
// 换句话说：整个游戏过程中，音效总是被当前最新事件"抢占"从头播放。
// 单实例够用；stop → seek(0) → play 三连保证每次都从 0 开始。
//
// 失败处理：onError 打 warn 日志，不抛出，游戏逻辑不受影响（比如文件缺失）。

// 唯一的音效文件：由用户指定。格式为 wav（小程序 InnerAudioContext 原生支持）。
const AUDIO_SRC = '/assets/audio/classic/mixkit-completion-of-a-level-2063.wav';

function createAudio() {
  let audio = null;
  try {
    audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
    audio.src = AUDIO_SRC;
    audio.volume = 1.0;
    audio.loop = false;
    audio.autoplay = false;
    audio.onError((err) => {
      // 文件缺失 / 格式不支持时只 warn，游戏继续能玩
      console.warn('[audio] error:', err);
    });
  } catch (e) {
    console.warn('[audio] create failed:', e);
    audio = null;
  }

  // 从头重播。stop 后紧接 seek(0) + play，保证事件频繁触发时也能始终"从开头"。
  function _play() {
    if (!audio) return;
    try {
      audio.stop();
      audio.seek(0);
      audio.play();
    } catch (e) {
      console.warn('[audio] play failed:', e);
    }
  }

  function _stop() {
    if (!audio) return;
    try { audio.stop(); } catch (_) { /* noop */ }
  }

  return {
    play: _play,
    stop: _stop,
    destroy() {
      try { if (audio) audio.destroy(); } catch (_) { /* noop */ }
      audio = null;
    }
  };
}

module.exports = {
  createAudio
};
