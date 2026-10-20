# dsh-closeout-button —— 输入框那一排的五个动作

> **出处**：2026-10-19 本机 DSH 会话建的客户端插件（用户要求"别每次手打收尾"）；
> 2026-10-20 用户要求把「重发上一条」也并进来；同日再把「按建议执行」并进来；
> 同日（晚）再加「继续」—— 用户原话："大多数时候都要说继续、按推荐执行、接受，能不能整成一个按钮，
> 相当于下一步" —— **一个插件、四个按钮 + 一块收口面板**
> （继续 / 收尾 / 按建议执行 / 重发上一条）。
> **是什么**：DSH 的 Web 端插件。⓪ 点「继续」把「继续」两个字填进当前会话并提交 ——
> 这是"没异议、往下走"的**通用答复**（继续 / 按推荐执行 / 接受 / 好的 / 行，都点它，不用再挑词）；
> ① 点「收尾」把「收尾」两个字填进当前会话并提交；
> ② 点「按建议执行」把「按建议执行」填进当前会话并提交（让 agent 照自己刚给的建议直接动手）；
> ③ 点「重发上一条」把最后一条**真人**用户消息原样再发一条。
> **状态**：**可用（2026-10-20 装机验证：桌面端启动成功、web boot 无失败项；同日 v0.4 加「继续」，离线 10 例全过）** ——
> 离线冒烟测试 10 例全过；五个格子在实时插槽树里都是 `active`（见「落点」）。
> **处置**：保留（`D:\dsh\dsh-closeout-button\`，工作区根下的插件源码，**git 仓库**：
> 2026-10-20 复核，`.git` 存在、历史 2 条以上；desktop profile 以 `link:D:/dsh/dsh-closeout-button` 指向它）。
> **关联**：`D:\dsh\tools\sessions-closeout.mjs`（收尾按钮触发的那条命令）· `D:\dsh\AGENTS.md`「会话收尾」。

## v0.4：多了「继续」

一句话需求：*"大多数时候都要说：继续、按推荐执行、接受——能不能整成一个按钮，
相当于下一步，没异议的时候就不用打字。"*

可行，而且**只是一个"替你打两个字"的按钮** —— 与「收尾」「按建议执行」共用同一段代码
（`makeTriggerAction`），差别只有文案与发出去的词：

```text
点「继续」 → composer.setDraft('继续') → composer.submit()
```

为什么是「继续」而不是「好的」/「接受」/「行」：agent 收到的都是同一件事
（"我同意，别问了，往下做"），但「继续」是这批词里**最没有歧义**的一个 ——
"接受""好的"在审批语境里才自然，"继续"在"接着写下去"与"按你说的做"两种语境都成立。
要换词只改 `lib/client.js` 的 `TRIGGER_CONTINUE` 一个常量。

三个"同意类"说法怎么分工（不用记，点错了也不会出事）：

| 你想说的 | 点哪个 | 实际发出去 |
| --- | --- | --- |
| 没异议，往下走 / 好的 / 接受 / 行 | 「继续」 | `继续` |
| 我认可你刚给的那套建议，照它做 | 「按建议执行」 | `按建议执行` |
| 这轮聊完了，收摊 | 「收尾」 | `收尾` |

> 前两个的区别只是**语气**：`继续` 更短、更通用；`按建议执行` 明确锁定"刚给的建议"，
> 适合 agent 给了 2-3 个方案、你不想它再列一遍的时候。两个都留着的成本只是多一个格子。

## v0.3：多了「收口面板」

前四个按钮都只是"替你打字"。第五个不一样：**点一下让宿主跑一次 `closeout`，把判断显示出来。**

```text
点「收口」 → POST /api/dsh-closeout/check（宿主路由）
           → 宿主 spawn `closeout --json --zh`，cwd = 当前会话记录的 cwd
           → 面板显示：结论 / 该不该交接 / 必须处理 / 顺手看一眼 / 没查的
```

**为什么必须在宿主做**：renderer 里没有进程与文件系统权限 —— 查不了 git、读不了临时目录。
所以 `lib/index.js`（宿主半部）注册一条 loopback 路由，`lib/client.js` 只负责画。

前提：`closeout` 在 PATH 里（`npm link` 或 `npm i -g dsh-closeout`），或用环境变量
`DSH_CLOSEOUT_BIN` 指到 `.mjs` / `.cmd`。找不到时面板会显示"跑不起来"并贴出 stderr 原文。

安全：路由只接受 **loopback + 同源 POST**，跨站请求 403；`cwd` 必须是存在的目录，否则 400。

## 它做了什么

```
点「继续」        → 取当前会话 → composer.setDraft('继续')       → composer.submit()
点「收尾」        → 取当前会话 → composer.setDraft('收尾')       → composer.submit()
点「按建议执行」  → 取当前会话 → composer.setDraft('按建议执行') → composer.submit()
点「重发上一条」  → 取最后一条真人用户消息的文本 → composer.setDraft(文本) → composer.submit()
```

这些按钮都只是"替你打一段字并提交"，其余行为与手打完全一样。用的全是宿主**公开服务**：

| 步骤 | API | 出处（装机插件/宿主包里的实测用法） |
|---|---|---|
| 注册按钮 | `ctx.slots.inject(SLOT, () => ctx.slots.register({name,id,order}, Component))` | `dsh-plugin-restart`（`sidebar.footer.action`） |
| 找当前会话 | `ctx.sessions.list.getSnapshot()`：先看 `state.current`，否则取 `byId` 里 `retainedBy.mainView > 0` 的那行 | `clearai-dsh` 的注释实测：新版 `SessionListState` **没有** `current` |
| 读历史消息 | `ctx.sessions.binding(id).eventSource.getSnapshot().entries`，条目形如 `{ event: { type, seq, time, data } }` | `@deepseek-ai/dsh-client-ui-chat` 的 `binding.eventSource`；`dsh-better-sidebar` 的 `user/message` 过滤 |
| 真人消息判据 | `event.type === 'user/message'` 且 `event.data.source.kind === 'user'` | `dsh-better-sidebar` 的 `isContextInjectionMessage` |
| 填并提交 | `ctx.get('conversation').input.for(scope).setDraft(text)` + `.submit()` | `@anionex/dsh-turn-rewind`、`dsh-better-sidebar` |

## 落点（两个插槽、五个格子）

`lib/client.js` 顶部：

```js
const SLOT_CONTINUE = 'conversation.input.left'   // 继续：输入框左侧工具区，order 4（最左）
const SLOT_CLOSEOUT = 'conversation.input.left'   // 收尾：同一个插槽，order 5
const SLOT_SUGGEST  = 'conversation.input.left'   // 按建议执行：同一个插槽，order 6（收尾右边一格）
const SLOT_PANEL    = 'conversation.input.left'   // 收口面板：同一个插槽，order 7
const SLOT_RESEND   = 'conversation.input.right'  // 重发：主发送/暂停键左侧那一排，order 5
```

同一个 `list` 插槽里放多个按钮 = **多个格子**，所以每个都必须用自己的 id：
`dsh-closeout-button:continue`（继续）、`dsh-closeout-button`（收尾）、
`dsh-closeout-button:suggest`（按建议执行）、`dsh-closeout-button:panel`（面板）。
复用别人的 id 会顶掉那个格子
（宿主插槽目录的原话：*reusing a shipped id puts you in THAT cell and replaces it*）。
实测两种写法的差别就是"两个按钮"还是"一个按钮"—— `test/client.test.mjs` 里有专门断言。

`conversation.input.right` 是宿主 `conversation.composer.bar` 声明的 `list` 插槽，与模型选择、
activity、主键同处输入框右下，列表顺序由 `order` 决定。

| 想放哪 | 改成 | 是否已被装机插件验证 |
|---|---|---|
| 输入框左侧（继续 + 收尾 + 按建议执行 + 面板默认） | `conversation.input.left` | ✅ 宿主 `composer bar` 的 list 插槽 |
| 发送/暂停键旁（重发默认） | `conversation.input.right` | ✅ 同上；紧邻主键 |
| 左侧栏底部 | `sidebar.footer.action` | ✅ `dsh-plugin-restart` / `dsh-session-manager` |
| 会话标题栏右侧 | `conversation.session.header.actions` | ✅ `dsh-turn-rewind` / `dsh-session-manager` |

改完要**重装/重启**（客户端模块是启动时快照）。

## 安装（GUI，因为 desktop profile 由应用独占管理）

> CLI `dsh plugin --profile desktop add …` 会被拒绝：`profile "desktop" is managed exclusively by the Electron application`（实测）。

1. **设置 → 插件**（插件经理）→「安装」→ 选择**本地目录** `D:\dsh\dsh-closeout-button`；
2. 安装后**重启应用**（客户端插件是启动时快照的）；
3. 信任确认（`dsh-trust-check` 能力披露）：本插件只有 `slots`/`locale` 两处注入，
   不读写文件、不出网、不碰凭据 —— 披露应该很干净；
4. 卸载：插件经理里 remove，再重启。

## 自检

```powershell
node --test D:\dsh\dsh-closeout-button\test\client.test.mjs   # 10 例：五个格子 / 继续 / 收尾 / 按建议执行 / 重发 / 注入过滤 / 禁用态 / 老宿主
node --test D:\dsh\dsh-closeout-button\test\host.test.mjs     # 7 例：路由（loopback / 同源 / 405 / 400 / 502 / stub 跑通）
node --check D:\dsh\dsh-closeout-button\lib\client.js
node --check D:\dsh\dsh-closeout-button\lib\index.js
```

## 已知边界

- **面板只读**：它只显示判断。处置动作（`git push`、删临时文件、`closeout --handoff`）仍要在终端做 ——
  推送与删除都是外部可见或不可逆的，不放进一个按钮里。
- **面板跑的是 PATH 里的 `closeout`**，不是插件自带的副本：版本要你自己保证（`closeout --help` 看得到）。
- **面板没有自动化 E2E**：路由层有 7 个用例（含 stub 跑通整条链路），但"按钮和面板是否出现在界面上"
  只能重启应用后人眼看。

- **「继续」文案固定**：发出去的就是这两个字（`TRIGGER_CONTINUE`），全角、不带标点 —— 与手打完全等价；
  它就是"继续 / 按推荐执行 / 接受 / 好的"这一族说法的**统一出口**，改词只改那一个常量。
- **「收尾」文案固定**：与 `D:\dsh\AGENTS.md`「会话收尾」的触发词一致；要改就改 `TRIGGER` 常量。
- **「按建议执行」文案固定**：发出去的就是这五个字（`TRIGGER_SUGGEST`），全角、不带标点、不带换行 ——
  与手打完全等价；改文案只改那个常量，别改别的。
- **它不替你判断"该不该收尾"**：只是把触发词发出去，收尾流程里该跑的体检/报告由会话按约定做。
- **输入框里已有草稿时会被覆盖**：`setDraft` 是整段替换，两个按钮都一样（刻意的简化）。
- **`submit()` 不存在的旧宿主**：自动降级成"只填草稿"，按钮上提示"已填入，按回车"。
- **重发只发文本**：附件、图片、引用不会随按钮复制；消息若只有附件没有文本，按钮禁用。
- **重发跳过注入消息**：`source.kind` 不是 `user` 的（引用、技能调用、压缩检查点等）不算"我发的消息"。
- **只读已加载窗口**：事件分页时取当前窗口里的最后一条；"上一条"总在窗口尾部，够用。
- **运行中可点**：重发按宿主正常提交语义排队成下一条，不阻塞当前轮次。
- **包名 = 模块 id = patch insert id，四处必须全等**：`package.json.name`、`lib/client.js` 里
  `__ModuleLoader__.load({ id })` 与 `NAMESPACE`、`lib/index.js` 的 `name`、`cordis.patch.yml` 的
  `insert.id`。**2026-10-20 实测事故**：只把包名从 `dsh-closeout` 改成 `dsh-closeout-button`、
  漏改客户端 id，loader 会认为 batch 里"没注册这个包"，**回落到单文件 URL 再执行一次**；第二次
  注册报 `duplicate factory registration for "dsh-closeout"`，整个 web boot 失败，桌面端弹
  "应用无法启动或已意外停止"（诊断日志 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`）。
  改名时用 `grep dsh-closeout` 自查一遍，`test/client.test.mjs` 里"id 必须等于包名"的断言就是闸门。

## 验证纪律（2026-10-20 实测事故，别再犯）

- **不要在应用运行时改 `lib/client.js` 做反例**。客户端模块有重载机制：把 `id` 临时改成旧名
  跑测试、再改回，会让同一个 factory 在同一个 renderer 里**注册两次**，报
  `duplicate factory registration for "dsh-closeout"`，renderer 直接崩溃
  （`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-renderer.log`）。本次就是我在反例验证时
  这么干，应用恰好正在运行，于是崩了一次；全新进程重启后恢复正常。
- **反例要作用在副本上**：把 `lib/client.js` 复制到 `tmp\` 下改名，让测试指向副本，
  永远不动正在被宿主监视的真实文件。
- **改完客户端源码要完全退出应用再启动**，不要依赖热重载；半途重载会留下旧注册，
  需要一次干净启动才清得掉。

