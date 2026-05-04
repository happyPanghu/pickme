// 音效服务：按下声 + 胜利号角
//
// 策略：
//   1. 点击音（tap）：用"实例池"轮转。多指同时按下会在几毫秒内连续触发 playTap()，
//      单实例 stop+seek+play 在部分小程序基础库上会吞播放。
//      开 TAP_POOL_SIZE 个实例轮流播，天然支持重叠触发。
//   2. 胜利音（win）：结算时只触发一次，单实例即可。
//   3. 多主题：通过 setScheme(id) 热切换资源路径。文件结构：
//        /assets/audio/{scheme}/tap.mp3
//        /assets/audio/{scheme}/win.mp3
//      任何 scheme 的文件缺失都只是 onError warn，不影响游戏逻辑。
//   4. 失败处理：onError 打 warn 日志（方便排查），不抛出。
//
// 扩展点：
//   未来"组队结算"可以加 playTeamWin(teamIndex)，用不同音效。
//   现在 win 单音效够用。

// ---- 音效主题清单 ----
// 顺序即切换时的循环顺序。每个主题对应 /assets/audio/{id}/ 下的 tap.mp3 + win.mp3。
const SCHEMES = [
  { id: 'classic', label: '经典',   icon: '🔔' },
  { id: 'cartoon', label: '卡通',   icon: '🫧' },
  { id: 'fanfare', label: '号角',   icon: '🎺' }
];

function _srcFor(schemeId, kind) {
  return '/assets/audio/' + schemeId + '/' + kind + '.mp3';
}

function _schemeById(id) {
  for (let i = 0; i < SCHEMES.length; i++) {
    if (SCHEMES[i].id === id) return SCHEMES[i];
  }
  return SCHEMES[0];
}

// 点击音实例池大小：3 个足够覆盖"5 指同时下按"的瞬时并发
// （人手按下在毫秒级错开，3 个轮转基本不会撞）
const TAP_POOL_SIZE = 3;

function _createAudio(src, volume, label) {
  let audio = null;
  try {
    audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
    audio.src = src;
    audio.volume = typeof volume === 'number' ? volume : 1;
    // 不循环，不自动播
    audio.loop = false;
    audio.autoplay = false;
    audio.onError((err) => {
      // 打 warn 但不抛出：文件缺失/格式不支持时游戏继续能玩
      console.warn('[audio] ' + (label || 'unknown') + ' error:', err);
    });
  } catch (e) {
    console.warn('[audio] create ' + (label || 'unknown') + ' failed:', e);
    audio = null;
  }
  return audio;
}

function createAudio(opts) {
  const options = opts || {};
  // 初始主题：优先 options.scheme，其次 SCHEMES[0]（classic）
  let currentScheme = _schemeById(options.scheme || SCHEMES[0].id);

  // 点击音实例池
  const tapPool = [];
  for (let i = 0; i < TAP_POOL_SIZE; i++) {
    tapPool.push(_createAudio(_srcFor(currentScheme.id, 'tap'), 0.7, 'tap[' + i + ']'));
  }
  let tapCursor = 0;

  // 胜利音单实例
  const win = _createAudio(_srcFor(currentScheme.id, 'win'), 1.0, 'win');

  // 从池子里挑下一个可用实例。
  // 优先用"已经结束播放"的；否则强制用下一个（会被中断，但播放很短没关系）
  function _nextTapInstance() {
    for (let i = 0; i < TAP_POOL_SIZE; i++) {
      const idx = (tapCursor + i) % TAP_POOL_SIZE;
      const a = tapPool[idx];
      if (!a) continue;
      // paused 属性在部分基础库不稳定，用 duration 和 currentTime 也不靠谱
      // 直接按 cursor 轮转即可：3 个实例的播放窗口基本不会重叠那么严重
    }
    const a = tapPool[tapCursor];
    tapCursor = (tapCursor + 1) % TAP_POOL_SIZE;
    return a;
  }

  function _playTap() {
    const a = _nextTapInstance();
    if (!a) return;
    try {
      a.stop();       // 停掉（如果正在播）
      a.seek(0);      // 回到开头
      a.play();
    } catch (e) {
      console.warn('[audio] playTap failed:', e);
    }
  }

  function _playVictory() {
    if (!win) return;
    try {
      win.stop();
      win.seek(0);
      win.play();
    } catch (e) {
      console.warn('[audio] playVictory failed:', e);
    }
  }

  // 热切换主题：把池里所有实例的 src 指向新 scheme 的文件
  function _setScheme(nextId) {
    const next = _schemeById(nextId);
    if (next.id === currentScheme.id) return currentScheme;
    currentScheme = next;
    const tapSrc = _srcFor(next.id, 'tap');
    const winSrc = _srcFor(next.id, 'win');
    for (let i = 0; i < tapPool.length; i++) {
      if (tapPool[i]) {
        try { tapPool[i].stop(); } catch (_) { /* noop */ }
        tapPool[i].src = tapSrc;
      }
    }
    if (win) {
      try { win.stop(); } catch (_) { /* noop */ }
      win.src = winSrc;
    }
    return currentScheme;
  }

  // 循环切到下一套主题，返回新主题对象（含 id/label/icon）
  function _cycleScheme() {
    const idx = SCHEMES.findIndex((s) => s.id === currentScheme.id);
    const next = SCHEMES[(idx + 1) % SCHEMES.length];
    return _setScheme(next.id);
  }

  return {
    playTap: _playTap,
    playVictory: _playVictory,
    // 多主题 API
    setScheme: _setScheme,
    cycleScheme: _cycleScheme,
    getScheme: () => currentScheme,
    getSchemes: () => SCHEMES.slice(),
    destroy() {
      for (let i = 0; i < tapPool.length; i++) {
        try { if (tapPool[i]) tapPool[i].destroy(); } catch (_) { /* noop */ }
      }
      try { if (win) win.destroy(); } catch (_) { /* noop */ }
    }
  };
}

module.exports = {
  createAudio,
  SCHEMES
};
