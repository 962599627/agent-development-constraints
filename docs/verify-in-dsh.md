# 在真实 DSH 里验证本插件

> 这份清单是为一次**已经发生过**的安装写的：插件已装进 `desktop` profile，
> 但 harness 内存里还是旧模块，需要**重启 DSH** 才会加载新代码。
> 保留在这里，因为以后更新插件后也是同一套验证流程。

## 重启后直接粘这句给 agent

> 重启后是新会话，之前那次安装的上下文已经不在了。把下面这段贴进去，
> agent 就知道要做什么：

```text
验证 agent-development-constraints 这个 DSH 插件是否真的工作。
参考 F:\agent-constraints\docs\verify-in-dsh.md。
重点确认三件事：
1. constraints 工具是否存在、action=where 返回的 cwd使用值 是不是当前会话目录
   （不是 DSH 安装目录）
2. 没有规则库时是否给出可操作提示而不是报错
3. 在临时目录 F:\_probe 放一份规则库后，constraints(action="l0") 能否列出铁律，
   以及每步注入（agent/pre-step）是否真的把铁律加进了消息
第 3 条里的"每步注入"是最需要确认的 —— 它是插件唯一还没被验证过的部分。
```

## 为什么必须重启

DSH 是 Electron 应用，插件在**启动时**从 profile 的 `node_modules` 加载进内存。
更新 `node_modules` 里的文件**不会**触发重载 —— 这个 profile 没有装
`@deepseek-ai/dsh-hmr`，所以没有热替换通道。

重启会结束当前会话。这是正常的，不是出问题。

## 重启步骤

1. 托盘/任务栏退出 DeepSeek Harness（**完全退出**，不是关窗口）
2. 重新打开
3. 打开任意一个会话（或新建），**工作目录指向 `F:\python2`**

## 验证清单

### ① 插件是否被加载

看工具列表里有没有 **`constraints`**。

或者直接让 agent 调用：

```
constraints(action="where")
```

**期望**：返回一段 JSON 诊断，而不是"未知工具"。

### ② 工作目录解析是否正确（这是上次踩的坑）

`where` 的输出里看 `cwd使用值`：

```json
{
  "cwd使用值": "F:\\python2",     ← 必须是会话的工作目录
  "agent可用": true,
  "session可用": true,
  "规则库": null                  ← 没装规则库时为 null，正常
}
```

**关键**：`cwd使用值` 必须是 `F:\python2`，**不能是 DSH 的安装目录**。

> 上次的 bug 就在这里：插件用 `process.cwd()` 找项目，而 Electron 应用的工作目录
> 是**应用目录**，于是在 `F:\python2` 会话里报"当前项目没有安装 agent-constraints"，
> 而规则库明明就在那里。修法是改用 `exec.agent.session.header.cwd`。

### ③ 没有规则库时的降级是否友好

```
constraints(action="path")
```

**期望**：返回一句**可操作**的提示（"以 npx agent-development-constraints install 安装"），
**而不是报错**。

### ④ 有规则库时能否真的读到（可选，需要装一份）

`F:\python2` 是博客仓库，**不要**把规则库装进去（会污染仓库）。
要测这一条就找个临时目录：

```powershell
mkdir F:\_probe\agent-constraints
Copy-Item F:\agent-constraints\core F:\_probe\agent-constraints\core -Recurse
```

然后在工作目录为 `F:\_probe` 的会话里：

```
constraints(action="l0")
```

**期望**：列出 L0 铁律（`R-001 凭据绝不硬编码` 等）。

### ⑤ 每步注入是否生效（最需要确认的一条）

这是插件的**核心卖点**，也是**唯一还没被验证过**的部分。

它监听 `agent/pre-step`，在每步之前把 L0 铁律摘要并入本步消息。
**在装了规则库的项目里**（如上一步的 `F:\_probe`），发一条普通消息，
然后看该轮的用户消息里有没有多出一段：

```
【开发约束 · 来自 agent-constraints】
规则库：F:\_probe\agent-constraints\core\constraints.md
L0 铁律（动手前逐条对照）：
  - R-001 凭据绝不硬编码
  ...
```

**如果没看到**，说明 `agent/pre-step` 的契约还有偏差 —— 那正是要修的东西。
`index.mjs` 里 `apply()` 的 ① 段就是实现，注释里写了契约要点：

```ts
'agent/pre-step'(payload: { agent, messages: UserMessage[], turn, step, signal },
                next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }
```

## 出问题怎么回滚

安装前把 profile 的配置文件备份到了同级的 `desktop.backup-<时间戳>` 目录：

```
%USERPROFILE%\.dsh\profiles\desktop.backup-*
```

（PowerShell 里就是 `"$env:USERPROFILE\.dsh\profiles"`。）

里面是 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `cordis.yml`。
把它复制回去覆盖，再重启即可。

只想禁用（保留文件）的话，从 `package.json` 的 `dsh.profile.bundles` 里
删掉 `agent-development-constraints` 那一行就行。

## 附：这次安装做了什么

```powershell
# 1. 装到 profile（用 DSH 自带的 pnpm，系统 PATH 里没有 pnpm）
$pnpm = 'F:\deepseek harness\resources\runtime\pnpm\bin\pnpm.cjs'
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node $pnpm add github:962599627/agent-development-constraints --config.auto-install-peers=false

# 2. 把包名加进 dsh.profile.bundles（少了这步装了也不会加载）
```

**第 2 步容易被忽略**：`pnpm add` 只写 `dependencies`，
而**决定加载哪些插件的是 `dsh.profile.bundles`**，两者都要有。
