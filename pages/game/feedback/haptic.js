// 震动反馈：封装 wx.vibrateShort / wx.vibrateLong，容错处理老基础库
//
// 使用场景：
//   light     手指按下（onFingerAdded）
//   medium    倒计时满、进入结算瞬间（可选）
//   heavy     victory 阶段入场（与赢家强调同步）
//   long      flooding 阶段入场（与铺屏动画同步）
//
// 为什么不直接 import wx：微信小程序里 wx 是全局，但做一层封装方便：
//   a) 兜底：某些老版基础库不支持 type 参数
//   b) 未来换端（H5 / 其他小程序）时只改这里

function _tryShort(type) {
  try {
    if (wx.vibrateShort) {
      // 新基础库支持 type: 'heavy' | 'medium' | 'light'
      wx.vibrateShort({ type: type || 'light', fail: () => {} });
    }
  } catch (_) {
    // noop
  }
}

function _tryLong() {
  try {
    if (wx.vibrateLong) wx.vibrateLong({ fail: () => {} });
  } catch (_) {
    // noop
  }
}

function createHaptic() {
  return {
    light() { _tryShort('light'); },
    medium() { _tryShort('medium'); },
    heavy() { _tryShort('heavy'); },
    long() { _tryLong(); }
  };
}

module.exports = {
  createHaptic
};
