---
name: hud-config
description: 当用户想要配置或自定义 agy-hud 的显示设置（主题、图标、面板模式等）时触发。
---

# 交互式配置 agy-hud 状态栏

当用户要求修改、设置、美化或配置 agy-hud 状态栏时，请遵循以下流程：

1. **发起交互选择题**：
   使用 `ask_question` 工具对用户发起提问，包含以下选项让用户进行单选：
   - **保存范围**：局部项目配置 (Local) 还是 全局默认配置 (Global)
   - **颜色主题**：翡翠绿 (Emerald Green)、深海蓝 (Ocean Blue)、赛博朋克 (Cyberpunk Magenta)、琥珀金 (Amber Gold)
   - **显示模式**：表格模式 (Table - 详尽多模型对比) 还是 紧凑模式 (Compact - 单行迷你图)
   - **图标字体**：Nerd Fonts (推荐，最精美图标)、Unicode Emojis (兼容性好) 还是 纯 ASCII (兼容低端终端)

2. **写入配置文件**：
   根据用户的选择，读取当前配置（或新建配置），并使用文件修改工具将配置保存到对应的 `agy-hud.config.json` 中：
   - 局部路径：当前项目根目录的 `./agy-hud.config.json`
   - 全局路径：用户主目录下的 `~/.gemini/antigravity-cli/agy-hud-runtime/runtime/agy-hud.config.json`
