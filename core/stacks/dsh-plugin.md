# DSH 插件开发 · 坑位库

> 每条都必须带「**症状**」—— 出了问题的人是从症状开始搜的，不是从原因。
> 换项目时整体替换这一份，L0/L1 不动。

---

### DSH · 装完插件后宿主会话直接失败，报 `Cannot read properties of undefined (reading 'kind')`

- **症状**：`Cannot read properties of undefined (reading 'kind')`；
  或插件加载后工具不出现、会话直接报"本轮运行失败"
- **原因**：插件顶层 import 了**装不上的包**：

  ```js
  import { defineTool } from '@deepseek-ai/dsh-tools'   // ❌
  ```

  配合 `package.json` 的 `"peerDependencies": { "@deepseek-ai/dsh-tools": "*" }`，
  而 profile 的 `pnpm-workspace.yaml` 里设了 `autoInstallPeers: false`
  —— **peer 依赖根本不会被安装**。于是模块解析失败 → 插件加载态 `FAILED`
  → 加载器处理那一行时拿到 `undefined` → 宿主会话崩。
- **修法**：**不 import 任何 harness 包**，直接手写 `ToolDefinition` 对象交给
  `ctx.tools.register()`。已装且工作正常的 `@liustack/modlens` 就是这么做的
  （它的外部依赖只有自己的 `commander`）：

  ```js
  ctx.tools.register(readImageTool(preferred))   // 手写对象，零 harness 依赖
  ```

  自查：`grep -nE "^import .* from ['\"][^'\"]+['\"]" index.js` → 只应剩 `node:` 开头的
- **来源**：agent-constraints 自身（2026-10-05）。见 L1 的 **C-009**

---

### DSH · 工具注册了但调用时报参数校验失败，或参数收不到

- **症状**：`invalid arguments: "action" must be one of [...]`，或 execute 里收不到参数
- **原因**：`parameters` 用了 `defineTool` 的 **DSL 格式**，而手写的 `ToolDefinition`
  要的是 **JSON Schema**；两者不通用

  ```js
  // ❌ defineTool 的 DSL（只在用 defineTool 时有效）
  parameters: { action: { type: 'string', required: true, enum: ['show', 'l0'] } }

  // ✅ 手写 ToolDefinition 要的 JSON Schema
  parameters: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['show', 'l0'] } },
    required: ['action']        // ← required 是数组，不是每个属性上的布尔
  }
  ```
- **修法**：判别标志是 `properties.xxx.required === true` —— 看到就是写错了。
  可对照 `modlens` 的 `dsh/index.js` 里 `readImageTool` 的真实格式
- **来源**：agent-constraints 自身（2026-10-05）

---

### DSH · 插件报「找不到项目文件」，但文件明明在

- **症状**：插件说"当前项目没有安装 X"，而 `X` 就在会话的工作目录里；
  手动 `node` 跑同一段逻辑却找得到
- **原因**：用了 `process.cwd()`。DSH 是 Electron 应用，
  **插件进程的工作目录是应用目录**，不是会话的工作目录
- **修法**：工具里用 `exec.agent.session.header.cwd`（会话创建时记录的
  validated absolute cwd）；事件回调里用 `payload.agent`

  ```js
  async execute(args, exec) {
    const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
  }
  ```
- **来源**：agent-constraints 自身（2026-10-05）

---

### DSH · 每步注入的上下文没出现，或注入后会话崩

- **症状**：`agent/pre-step` 里加的提示在对话里看不到；
  或注入后报错、会话中断
- **原因**：`agent/pre-step` 是 **waterfall**，返回值必须是 `PreStepDecision`，
  且消息是 `UserMessage[]` 而**不是** `ContentBlock`

  ```ts
  'agent/pre-step'(
    payload: { agent, messages: UserMessage[], turn, step, signal },
    next: () => Promise<PreStepDecision>
  ): Promise<PreStepDecision>

  type PreStepDecision =
    | { kind: 'reject' }
    | { kind: 'enter'; messages: UserMessage[] }
  ```

  ```js
  // ❌ ContentBlock 形状
  decision.messages.unshift({ type: 'text', text: brief })

  // ✅ UserMessage 形状，且只追加在末尾（人类输入要留在最前）
  return {
    ...decision,
    messages: [...decision.messages,
               { role: 'user', content: [{ type: 'text', text: brief }] }]
  }
  ```
- **修法**：两条硬性要求 ——
  ① **必须调用 `next()`**（waterfall 不调用它会短路整条链）；
  ② `kind !== 'enter'` 时**原样透传**，改写宿主的决定会让会话失败
- **来源**：agent-constraints 自身（2026-10-05）

---

### DSH · 装进 profile 了，但插件根本没被加载

- **症状**：`node_modules` 里有包，但重启后工具/功能不出现
- **原因**：只 `pnpm add` 了，没加进 `dsh.profile.bundles`
- **修法**：**两处都要有**

  ```jsonc
  // profile 的 package.json
  {
    "dependencies": { "your-plugin": "github:owner/repo" },   // ① 装
    "dsh": { "profile": { "bundles": ["...", "your-plugin"] } } // ② 加载
  }
  ```

  系统 PATH 里通常没有 `pnpm`，用 DSH 自带的：

  ```powershell
  node 'F:\deepseek harness\resources\runtime\pnpm\bin\pnpm.cjs' add <pkg> --config.auto-install-peers=false
  ```
- **来源**：agent-constraints 自身（2026-10-05）

---

### DSH · 改了插件源码，但行为没变

- **症状**：`node_modules` 里的文件明明是新的，运行行为还是旧的
  （例如新增的 action 报"必须是旧的那几个"）
- **原因**：`node_modules` 的文件变更**不会触发热替换**；
  插件在**启动时**加载进内存。除非 profile 装了 `@deepseek-ai/dsh-hmr`
- **修法**：先查有没有 hmr：

  ```powershell
  Select-String -Path "$env:USERPROFILE\.dsh\profiles\<name>\package.json" -Pattern 'hmr'
  ```

  没有 → **必须重启 DSH**（完全退出进程，不是关窗口）。
  **注意**：重启会结束当前会话，所以重启前要把该提交、该记录的都做完
- **来源**：agent-constraints 自身（2026-10-05）。与 L0 的 **R-008** 同源

---

### DSH · 安装插件前的最小自查（不碰使用者环境）

- **症状**：不是症状，是**交付前的固定动作** —— 前三步能在不动使用者环境的前提下
  挡掉绝大多数问题
- **原因**：插件跑在宿主里，一旦加载失败可能**让宿主整体不可用**，
  而使用者为此付出的代价远大于插件本身的价值
- **修法**：按顺序做

  1. **静态检查依赖**：`grep -nE "^import .* from ['\"][^'\"]+['\"]" index.js`
     → 应当只有 `node:` 开头的
  2. **本地直接加载**（**不造 stub**）：
     `node --input-type=module -e "import('./index.js').then(m => console.log(m.name))"`
     → 能加载才说明真实环境下也能加载
  3. **畸形输入不崩**：`apply()` 传 `{}`、`{ tools: null }`、`{ on: () => { throw ... } }`
     → 只降级、不抛错
  4. **然后才装**，并**先备份** profile 的配置文件
  5. **先想好回滚**：从 `dsh.profile.bundles` 删掉那一行 → 重启
- **来源**：agent-constraints 自身（2026-10-05）。见 L1 的 **C-009 / C-010**
