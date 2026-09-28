# 用量环 · Usage Ring

在 Codex 桌面版侧栏顶部显示简洁的额度环。与 [Metal & Beam](https://github.com/Ne1ther/codex-tweaks-metal-beam) 搭配使用，也可以单独启用。

## 功能

- 优先显示 5 小时与每周剩余额度。只有一种限额时显示单环；缺少数据时不展示误导性的百分比。
- 悬停或键盘聚焦查看完整用量、重置时间和手动重置卡；点击打开 Codex 自带的用量设置。
- 圆环只在额度变化时做一次短暂过渡，没有持续动画、WebGL 画布或后台程序。支持明暗主题、键盘焦点和减少动态效果。
- 不读取会话 Token，不修改文件夹颜色。

## 安装

在原版 **Codex Tweaks → 功能包 → 从 Git 安装**中输入 `https://github.com/Ne1ther/codex-tweaks-usage-ring.git`，选择 `v0.1.0` 或最新语义化标签，编译后启用 `ct-usage-ring`。它替代 `ct-usage-overview` 的顶部用量组件；启用前请停用旧包，避免两个组件挤在同一位置。

也可以从 [Releases](https://github.com/Ne1ther/codex-tweaks-usage-ring/releases) 下载 ZIP，在 Tweaks 中安装本地包。根目录包含 `package.json`，不含宿主应用和符号链接。

## 权限与兼容

- Renderer：读取 Codex 已有的用量 Query Cache，在一级侧栏添加圆环和悬停卡。停用时移除全部节点、监听器和计时器。
- Node：不使用。网络：不自行请求。不会读取聊天正文或本地会话数据库。
- Codex Tweaks API v3；已在 macOS 的原版宿主中验证。额度读取依赖 Codex 当前页面的内部状态，客户端更新后可能需要适配。
- Metal & Beam 将用量环视为独立控件，不给它叠加金属效果。

## 开发

`npm run check` 验证语法及用量环的数据选择逻辑；最终编译以 Codex Tweaks 功能包页面为准。包的 Renderer 入口是 `src/index.js`，没有 npm 运行时依赖。

## 来源与许可

用量读取、完整详情与导航逻辑基于 MIT 许可的 [codex-tweaks-usage-overview](https://github.com/codex-tweaks/codex-tweaks-usage-overview)，并保留其版权声明。双环的表达借鉴了 MIT 许可的 [codex-usage-badge](https://github.com/jaykinhoo9/codex-usage-badge)；本包的轻量 SVG 界面另行实现。见 [LICENSE](LICENSE)。
