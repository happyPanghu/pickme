# Chwazi 微信小程序

一款用**多指触摸 + 随机选择**来做多人决策的微信小程序游戏，致敬经典应用 [Chwazi](https://chwazi.com/)。

几个人选不出谁请客、谁开车、谁去跑腿的时候，大家把手指按在屏幕上，3 秒后随机选出赢家。

---

## ✨ 功能特性

- 🎨 **多指彩色圆圈**：每根手指落下后生成一个带呼吸动画、独立随机颜色和略有差异大小的实心圆
- 🔀 **随机决胜**：2 根以上手指按住不动 3 秒后，在所有参与者中 Fisher-Yates 公平抽签
- 🏆 **多赢家支持**：可设置 1~N 个赢家，结算时按 Voronoi 分区各占屏幕 1/N
- 💥 **戏剧化胜利结算**：输家立即淡出 → 赢家放大强调 1 秒 → 颜色从赢家位置向外扩散铺满整屏
- 🎭 **加法混色重叠**：两个圆圈交叉时，重叠处呈现加色混合色（红+绿=黄、红+蓝=品红）
- 📱 **刘海屏/灵动岛适配**：所有 UI 通过 `env(safe-area-inset-*)` 适配异形屏
- 🎯 **无限颜色生成**：HSL 色彩空间程序化生成，保证色相差 ≥40°、黑底清晰可见
- 📳 **三段震动反馈**：按指（light）→ 决胜（heavy）→ 铺屏（long），节奏感强

---

## 🏗️ 目录结构

```
.
├── app.js / app.json / app.wxss    小程序入口 + 全局配置（自定义导航栏，黑色主题）
├── pages/
│   └── game/
│       ├── game.wxml               舞台 + Canvas + 顶部提示 + 底部控制栏
│       ├── game.wxss               安全区适配、按钮样式
│       ├── game.js                 全部逻辑（约 890 行，见下文"代码地图"）
│       └── game.json               页面配置（自定义导航栏）
├── sitemap.json                    搜索配置
├── project.config.json             开发工具项目配置
└── README.md
```

---

## 🗺️ `pages/game/game.js` 代码地图

整个游戏逻辑集中在这一个文件里，按功能分为 6 个区块：

| 行号（约） | 区块 | 职责 |
|---|---|---|
| 1-22 | **常量区** | 所有可调参数（倒计时时长、动画时长、半径、watchdog 阈值…） |
| 24-91 | **颜色生成** | HSL 程序化生成随机颜色、HSL→RGB 转换、相邻色相距离约束 |
| 93-145 | **Page 生命周期 + Canvas 初始化** | `onLoad` 初始化运行时状态，`initCanvas` 查询 canvas 节点、设置 DPR |
| 147-305 | **主循环 + render** | rAF 驱动，分 `flooding` 和 `正常/victory` 两条绘制路径 |
| 307-405 | **触摸事件处理** | `onTouchStart / Move / End / Cancel`，含 watchdog 快照维护 |
| 407-560 | **一致性工具** | `_updateTouchSnapshot`（watchdog 快照）、`reconcileFingersWith`（幽灵清理） |
| 562-775 | **倒计时 + 决胜 + UI 交互** | `restartCountdown` / `pickWinners` / `incWinner` / `resetGame` 等 |
| 777-893 | **绘制 + 几何工具** | `drawCircle / drawGlow / drawSolid`、缓动函数、Voronoi 半平面裁剪 |

---

## 🔑 核心算法与设计决策

> 下面是完整的技术解读，便于后续维护或二次开发时快速理解"为什么这样写"。

### 1. 手指生命周期状态机

每根手指落下后，对应一个 `finger` 对象，在 5 种状态间流转：

```
touchstart ──▶ spawning ──(220ms)──▶ alive ──(3s 不动)──▶ victory (赢家)
                                      │                  │
                                      │                  └─▶ (1s 后进入 flooding 阶段)
                                      ▼
                                   despawning ──(180ms)──▶ [从 Map 删除]
                                   ▲
                                   ├── touchend / touchcancel（正常路径）
                                   ├── reconcileFingersWith（touches 快照完整覆盖时的幽灵清理）
                                   └── watchdog（创建 >400ms 且不在快照里，兜底清理）
```

render 函数的主循环（rAF 驱动）每帧对 Map 里的每个 finger 按状态画出不同形态：

- `spawning`：`easeOutBack` 回弹缓动从 0 → 基础半径
- `alive`：正弦呼吸，半径 = `基础半径 + 8px × sin(2π × t / 1100ms)`
- `victory`：1 秒内放大到 1.8×，光晕增强到 3.5×，附带 6Hz 脉冲
- `despawning`：`easeInCubic` 缓动缩小到 0，同步淡出，完成后删除

### 2. 多指触摸的幽灵处理（三层防御）

小程序 + iOS WebKit 的多点触摸事件存在两个已知问题：

- **5 指上限**：iOS 的 `e.touches` 最多返回 5 个 touch，第 6 指按下时快照会变短甚至丢失
- **touchend 偶尔丢失**：特别是快速点击、页面重排期间，触发 touchstart 后对应的 touchend 可能不到达

为了让屏幕上不残留"幽灵圆圈"，代码实现了**三层防御**：

| 层 | 机制 | 触发时机 | 延迟 |
|---|---|---|---|
| 第一层 | `onTouchEnd` / `onTouchCancel` | 正常事件流 | 0ms |
| 第二层 | `reconcileFingersWith` | 每次 touchstart/touchend，仅当 `e.touches` 完整覆盖 Map 时才生效 | 10~50ms |
| 第三层 | Watchdog（见 `_updateTouchSnapshot`） | render 循环每帧检查，若 finger 创建 >400ms 且不在最近 touches 快照里 → 强制 despawn | ≤ 400ms |

**关键保守策略**：第 6 指按下时，`e.touches` 只返回 5 个——如果盲目 reconcile 会把前 5 指误判为"幽灵"全部清掉。所以每一层都先验证"快照是否完整覆盖 Map 里的活跃 finger"，**宁可多等一会儿也不允许误杀**。

### 3. 胜利结算三段式动画

从倒计时到 0 开始，结算分三段演绎，营造"抓住 → 蓄力 → 爆发"的节奏感：

```
t=0ms     pickWinners()
          ├─ Fisher-Yates 洗牌选 N 个赢家
          ├─ 输家：state='despawning'（180ms 内淡出消失）
          ├─ 赢家：state='victory'（开始放大 + 光晕增强）
          ├─ vibrateShort({type:'heavy'})  ← 决胜震动
          └─ setTimeout(进入 flooding, 1000ms)

t=0~1000  "赢家强调"阶段
          - 每帧赢家半径从 1×baseRadius 平滑放大到 1.8×baseRadius
          - 光晕从 1× 增强到 3.5×
          - 叠加 sin(6πt) × 6px 轻微脉冲

t=1000    setData({flooding: true})
          vibrateLong()    ← 庆祝震动

t=1000~1700  "铺屏"阶段（700ms）
             - 每个赢家扩散圆从 1.8×baseRadius → maxRadius（对角线）
             - 多赢家时按 Voronoi 分区，各自在自己区域内扩散
```

**衔接设计**：flooding 起始半径 = `FINGER_RADIUS × VICTORY_MAX_SCALE × sizeScale`，与 victory 阶段最终大小对齐，视觉上无跳变。

---

## 🧪 开发与测试

1. 用微信开发者工具打开本目录
2. AppID 使用"测试号"（`project.config.json` 里为 `touristappid`）即可
3. 真机预览推荐 iOS（多指触摸最稳定）；安卓部分机型 `e.touches` 快照有兼容问题，本项目已用 watchdog 兜底

---

## 📜 License

个人学习项目，自由使用。
