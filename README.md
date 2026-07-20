# Grok Obsidian

在 **桌面端 Obsidian** 中调用本机 **Grok CLI**，通过极简的 **Grok Obsidian** 侧边面板直接对话。

> **Desktop only** · 需要本机已安装并登录 `grok`。

## 功能

- **Grok Obsidian 面板**：使用项目 `icon.png`、精简状态提示、当前模型名称与 Markdown 消息展示
- **直接聊天**：在侧边栏发送消息，并在同一 session 中继续追问；回答支持流式显示（增量更新，避免整表重绘）
- **图片理解**：粘贴截图、点击回形针上传，或拖入图片；图片会转为 PNG 并保存到 Vault 附件目录
- **上下文选择**：输入 `@` 选择文件或文件夹，输入 `#` 选择标签（支持层级匹配），输入 `/` 选择自定义提示词
- **活动笔记开关**：明确控制当前笔记是否作为上下文发送
- **历史与操作**：对话、session ID 和附件路径持久化；支持编辑/复制、重新生成、停止、历史切换与删除
- **附件清理**：删除对话或移除待发送图片时可清理 `Grok Screenshot` 附件；设置中可一键清理孤立截图
- **错误可见**：模型错误、非零退出和超时会终止任务，并在对应回答下保留可展开的错误详情
- **安全修改**：文本与图片会话均默认 `plan` 权限；“Diff” 支持**多文件**与**局部 SEARCH/REPLACE**，预览后勾选再应用
- **来源跳转**：回答下方的文件、文件夹和标签来源可点击打开

## 安装（开发）

```bash
cd /path/to/obsidian-grok-build
npm install
npm run build
npm test
```

将整个目录复制或联接到：

```text
<你的库>/.obsidian/plugins/obsidian-grok-build/
```

需包含：

- `manifest.json`
- `main.js`（build 产物）
- `styles.css`
- `icon.png`

然后：Obsidian → 设置 → 社区插件 → 关闭安全模式 → 启用 **Grok Obsidian**。

### Windows 联接示例

```powershell
# 在库的 plugins 目录下创建目录联接
New-Item -ItemType Junction `
  -Path "D:\MyVault\.obsidian\plugins\obsidian-grok-build" `
  -Target "E:\obsidian-plugin\obsidian-grok-build"
```

## 使用

1. 确认终端可运行：`grok -p "hi" --output-format plain`
2. 打开右侧 Grok Obsidian，在输入框中直接发送消息（`Enter` 发送，`Shift+Enter` 换行）
3. 输入 `@` 后搜索文件；使用方向键选择，按 `Enter` / `Tab` 插入，按 `Esc` 关闭
4. 也可以打开命令面板：
   - `Open Grok Obsidian`
   - `Grok Obsidian: start a new conversation`
   - `Grok Obsidian: clean up orphan screenshots`
5. 右侧 **Grok Obsidian** 会显示聊天记录；运行时发送按钮会切换成停止按钮
6. 插件默认自动检测 `~/.grok/bin/grok(.exe)` 和系统 `PATH`；需要时可在设置中覆盖路径
7. 鼠标移到消息下方可复制；用户消息还可以点铅笔图标回填编辑，该消息之后的旧分支会被移除

## 设置说明

**常用**

| 项 | 默认 | 含义 |
|----|------|------|
| 当前 Grok CLI | 自动探测 | 显示检测到的可执行文件 |
| 默认附带当前笔记 | 开 | 新对话默认带上最近聚焦笔记 |
| 对话历史上限 | 20 | 本地保留的对话数量（立即生效） |
| 清理时删除截图附件 | 开 | 删除对话/移除图片时清理 Vault 截图 |
| 斜杠提示词 | 总结/润色/翻译 | 可自定义常用提示词 |

**模型**：始终使用本机 Grok Build / CLI 默认模型（插件不再提供覆盖项）。

**高级**（折叠）：自定义 grok 路径、超时、最大回合数、禁用工具、额外 rules。

## 原理

```text
文本回合:
  grok --prompt-file <tmp> --cwd <vault> --output-format streaming-json --permission-mode plan ...
图片回合 (ACP):
  grok --permission-mode plan --max-turns N --rules ... agent stdio
  session/resume（若有）或 session/new + image content blocks
解析流:
  thought → 「思考中」
  text    → 「回复中」+ 增量 UI
  end     → 完成 / Markdown 渲染
```

## 限制

- 不支持移动端
- 依赖本机 grok 登录态 / 网络
- Diff 解析格式见下方；SEARCH 必须在目标文件中**唯一匹配**，否则拒绝该局部修改
- 上下文默认上限：文件 8、文件夹 4、标签 6、总路径 32；单文件约 50KB、总计约 180KB
- 图片 ACP 会话与 headless session 可能不在同一 ID 空间；图片回合会注入近期对话文本作为补偿
- 若关闭「清理时删除截图附件」，删除对话不会清理 Vault 中的截图
- 若 Obsidian 进程 PATH 不含 grok，请填绝对路径

## Diff 格式（模型输出约定）

**全文替换 / 新建（可多文件）：**

````markdown
```md:Notes/a.md
# 完整正文
```

```md:Notes/b.md
另一篇
```
````

或标题 + 代码块：

````markdown
### Notes/a.md
```md
完整正文
```
````

**局部修改：**

```markdown
### Notes/a.md
<<<<<<< SEARCH
旧文本（须在文件中只出现一次）
=======
新文本
>>>>>>> REPLACE
```

若回答里没有带路径的变更块，会回退为「用整段内容替换当前活动笔记」。

## 开发

```bash
npm run build   # TypeScript 检查 + 生产打包
npm test        # 纯函数单测（diff / context / ACP args）
npm run dev     # esbuild watch
```

## License

MIT
