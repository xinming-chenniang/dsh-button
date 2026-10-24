# dsh-button —— 插件工作区指针

> 本仓库是 `D:\dsh\plugins\` 产品组合中的**获客产品**。开工前先读：
> 1. [`../PRODUCT-PLAN.md`](../PRODUCT-PLAN.md) — 组合定位、90 天目标、发布日历
> 2. [`../RELEASING.md`](../RELEASING.md) — 发布规则、冻结期、checklist
> 3. [`../README.md`](../README.md) — 组合清单与当前版本
> 4. 本仓库 `README.md` — 安装、边界、兼容性

## 当前状态

- 版本：**1.2.3**（npm `latest`；GitHub `v1.2.3`）；工作树另有**未发布**的「直接发送 / 填入输入框 + ↑↓ 排序」（2026-10-24）
- 市场：PR **#8774 已 MERGED**（钉 1.2.3）；新版本要另开 PR，不改已合并条目
- 测试：`npm test` → 45/45
- 定位：输入框上方/下方/控制行的纯文本动作；所有按钮（含继续）同一套顺序；无重发；⋮ 设置固定在左组最前；发送实底 / 填入虚线；模型可实验性强制收起

## 硬规则

- 不为了 README/CHANGELOG/截图单独发版；非安全修改攒到 release train。
- 发布前：`npm test`、`npm pack --dry-run`、README/CHANGELOG 对齐、干净工作树，缺一不发。
- 不主动做 Phase 2（跟随 `busyEnter`）；先等真实需求，并先解决 `configForms`/`steeringAvailable` 验证。
- 不改 `~/.dsh/profiles`；profile 只 `link:` 本目录。
