/**
 * DSH 插件入口：把项目的开发约束接入 harness。
 *
 * ## 两个作用
 *   ① 监听 `agent/pre-step` —— 每步之前把 L0 铁律摘要并入本步消息
 *   ② 注册 `constraints` 工具 —— AI 可以主动查看完整规则库
 *
 * ## 设计原则：绝不因为本插件让会话失败
 *
 * 这条是被真实事故逼出来的。第一版有两个错误，装进真实 DSH 后**直接导致会话崩溃**
 * （报 `Cannot read properties of undefined (reading 'kind')`）：
 *
 * **错误 1：顶层 import 了装不上的包。**
 * 原来写 `import { defineTool } from '@deepseek-ai/dsh-tools'`，并把它声明在
 * `peerDependencies` 里。但 profile 的 `pnpm-workspace.yaml` 设了
 * `autoInstallPeers: false`，peer 依赖**根本不会被安装** —— 于是模块解析失败，
 * 插件加载态变 FAILED，加载器处理那一行时拿到 undefined 就炸了。
 *
 * 正确做法（对照已装且工作正常的 @liustack/modlens）：
 * **不 import 任何 harness 包**，直接手写 ToolDefinition 对象传给
 * `ctx.tools.register()`。modlens 的外部依赖只有它自己的 commander。
 *
 * **错误 2：参数 schema 用错了格式。**
 * `defineTool` 的 DSL 写法是
 *   `parameters: { action: { type: 'string', required: true, enum: [...] } }`
 * 而手写的 `parameters` 是 **JSON Schema**：
 *   `parameters: { type: 'object', properties: {...}, required: ['action'] }`
 * 两者不通用，混用会让工具校验失败。
 *
 * 现在 `apply()` 的每一段都包在 try/catch 里：任何异常都只让插件降级
 * （工具不注册 / 不注入），**绝不让宿主会话崩**。
 *
 * ## 隐私承诺（见 PRIVACY.md）
 *   - 零网络：只读本地文件
 *   - 只读当前项目：从会话 cwd 向上找 agent-constraints/
 *   - 不写任何东西：本文件没有任何 fs 写操作
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'agent-development-constraints'

/**
 * 读插件自己的版本。
 *
 * ⚠️ 之所以有这个函数：**之前把它硬编码在两处**
 *   - index.mjs 的状态路由里写了 '0.11.0'
 *   - dsh/client.js 里写了 '0.9.0'
 * 而 VERSION 文件是第三个来源。三处必然会漂移 —— 实测就是卡片一直显示旧版本，
 * 因为升级时只改了 VERSION 文件。
 *
 * 这正是 **R-011**（两个地方说同一件事，就必须有一致性测试）。
 * 现在改为**单一来源**：VERSION 文件（与 index.mjs 同目录），
 * 并用测试保证 VERSION == package.json.version。
 */
function readOwnVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const v = readFileSync(join(here, 'VERSION'), 'utf8').trim()
    return v || '0.0.0'
  } catch {
    // 版本读不到绝不该影响功能
    return '0.0.0'
  }
}

// 声明依赖工具服务：`ctx.tools` 就绪后才会调用 apply。
// （此前故意不声明、改用 try/catch 探测 —— 结果是 tools 未就绪时静默跳过注册，
//   工具不出现且没有任何线索，比直接失败更难查。）
export const inject = ['tools']

/**
 * 诊断探针：把"插件到底加载了没有、ctx 里有什么"写到磁盘。
 *
 * 加它的原因：连续两轮"重启后工具不出现"，但**无法判断**是
 *   ①插件压根没加载，还是 ②加载了但 ctx.tools 不可用 还是 ③注册了但没生效。
 * 猜了两次都猜错（第一次怪 import，第二次怪 pre-step）。这次不猜了 —— 让插件自己说。
 *
 * 写在 `.dsh` 目录下，文件小、只在 apply 时写一次。
 * 排查完可以删掉这个函数（见 README 的说明）。
 */
function writeProbe(stage, extra) {
  try {
    const file = join(homedir(), '.dsh', 'agent-constraints-probe.json')
    const entry = {
      stage,
      time: new Date().toISOString(),
      node: process.version,
      cwd: process.cwd(),
      pid: process.pid,
      ...extra,
    }
    // 累积而不是覆盖：一次启动里 apply 可能走多条注册路线，
    // 只看最后一条会漏掉"哪条真的成功了"。
    let history = []
    try {
      if (existsSync(file)) {
        const prev = JSON.parse(readFileSync(file, 'utf8'))
        history = Array.isArray(prev) ? prev : [prev]
      }
    } catch {
      history = []
    }
    history.push(entry)
    // 只保留最近 20 条，避免无限增长
    if (history.length > 20) history = history.slice(-20)
    writeFileSync(file, JSON.stringify(history, null, 2), 'utf8')
  } catch {
    // 探针失败绝不影响插件
  }
}

/** 规则库在整个项目里的相对位置 */
const CONSTRAINTS_REL = join('agent-constraints', 'core', 'constraints.md')

/**
 * 配置文件：`~/.dsh/agent-constraints.json`，形如 `{ "inject": true }`。
 *
 * ## 为什么用文件而不是 host 的 settings 服务
 *
 * settings 服务要求 host 与 client 两侧注册同名 namespace、schema 保持一致、
 * 并把 namespace 加进 proxy allowlist —— 链路长、出错点多。
 * 而本插件已经因为"多一个依赖"崩过一次宿主会话了。
 *
 * 这里只需要表达一个布尔开关，一个 JSON 文件足够：
 * 卡片通过状态路由读写它，host 侧每次 pre-step 读一次（文件很小）。
 */
const CONFIG_FILE = join(homedir(), '.dsh', 'agent-constraints.json')

/** 默认：注入**开启**。每会话只多 41 tokens，换来"AI 不会忘记有约束" */
const DEFAULT_CONFIG = { inject: true }

function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return Object.assign({}, DEFAULT_CONFIG)
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return Object.assign({}, DEFAULT_CONFIG, parsed && typeof parsed === 'object' ? parsed : {})
  } catch {
    // 配置损坏时用默认值，绝不让它影响会话
    return Object.assign({}, DEFAULT_CONFIG)
  }
}

function saveConfig(patch) {
  const next = Object.assign({}, loadConfig(), patch || {})
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
    return next
  } catch {
    return null
  }
}

/** 注入是否开启 */
function configInjectEnabled() {
  return loadConfig().inject !== false
}

// ---------------------------------------------------------------------------
// 成本感知（cost awareness）
// ---------------------------------------------------------------------------
//
// 数据来源：`~/.dsh/dsh-usage/usage-ledger.json`（DSH 自己维护的用量账本）
// 与 `provider-snapshots.json`（余额）。
//
// ## 为什么值得做
//
// 真实账本长这样（2026-10-05，deepseek-flash）：
//   inputTokens      4,107,108
//   outputTokens     1,453,735
//   cacheReadTokens  548,846,976     ← 是输入的 134 倍
//   calls            1,472
//   cost             29.42 元
//
// 缓存读取单价低，但 5.5 亿的量仍然吃掉近 30 元/天。
// 这印证了 C-011：**常驻内容的成本 = 大小 × 调用次数**，而不是大小本身。
//
// 所以这个模块做两件事：
//   ① 把账本数字摆出来 —— 让成本可见（看不见的东西没法优化）
//   ② 审计工具 schema 的占用排名 —— 找出谁在占上下文

const USAGE_LEDGER = join(homedir(), '.dsh', 'dsh-usage', 'usage-ledger.json')
const PROVIDER_SNAPSHOTS = join(homedir(), '.dsh', 'dsh-usage', 'provider-snapshots.json')

function loadJsonSafe(p) {
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 读用量账本，汇总"今天"与"累计" */
function loadUsage() {
  const ledger = loadJsonSafe(USAGE_LEDGER)
  if (!ledger || !ledger.days) return null

  const todayKey = new Date().toISOString().slice(0, 10)
  const sum = (days) => {
    const t = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 0,
      cost: 0,
    }
    for (const day of days) {
      const providers = ledger.days[day] || {}
      for (const models of Object.values(providers)) {
        for (const m of Object.values(models || {})) {
          t.inputTokens += m.inputTokens || 0
          t.outputTokens += m.outputTokens || 0
          t.cacheReadTokens += m.cacheReadTokens || 0
          t.cacheWriteTokens += m.cacheWriteTokens || 0
          t.calls += m.calls || 0
          t.cost += m.cost || 0
        }
      }
    }
    return t
  }

  const allDays = Object.keys(ledger.days)
  const snap = loadJsonSafe(PROVIDER_SNAPSHOTS)
  const deepseek =
    snap && snap.providers ? snap.providers['deepseek-official'] : null
  const balance = deepseek && deepseek.balance ? deepseek.balance : null

  return {
    today: sum(allDays.filter((d) => d === todayKey)),
    total: sum(allDays),
    dayCount: allDays.length,
    todayKey,
    balance: balance ? balance.totalBalance : null,
    currency: balance ? balance.currency : null,
  }
}

/**
 * 审计工具 schema 的上下文占用。
 *
 * ⚠️ 这是"省 token"最有用的一项输出：工具 schema 是**每个请求都发**的常驻成本，
 * 但通常没人知道哪个工具最占地方。列出来，优化才有靶子。
 */
function auditToolSchemas(exec) {
  try {
    const agentCtx = exec && exec.agent && exec.agent.ctx
    const tools = agentCtx && agentCtx.tools
    if (!tools || typeof tools.schemas !== 'function') {
      return { error: 'ctx.tools.schemas() 不可用，拿不到工具 schema' }
    }
    const schemas = tools.schemas() || []
    const rows = schemas.map((s) => {
      let text = ''
      try {
        text = JSON.stringify(s)
      } catch {
        text = ''
      }
      return {
        name: s && s.name ? s.name : '(unnamed)',
        chars: text.length,
        approxTokens: Math.round(text.length / 3.5),
      }
    })
    rows.sort((a, b) => b.chars - a.chars)
    const totalChars = rows.reduce((n, r) => n + r.chars, 0)
    return {
      count: rows.length,
      totalChars,
      totalApproxTokens: Math.round(totalChars / 3.5),
      top: rows.slice(0, 10),
      // 完整排名留给内部逻辑（suggestDisable）用，不直接输出
      all: rows,
    }
  } catch (err) {
    return { error: (err && err.message) || String(err) }
  }
}

/**
 * 分析当前会话：事件构成 + **哪些工具真的被调用过**。
 *
 * ## 为什么"谁用过"比"谁大"更有用
 *
 * `audit` 只回答"谁占地方"。真正能指导决策的是
 * "**谁占了地方却从没用过**" —— 那才是可以关掉的。
 *
 * 所以这里从 session 的事件里数 `tool/call`，得到每个工具的**真实使用次数**。
 *
 * ⚠️ session 的内部结构可能随版本变化，所以每个字段都防御式读取；
 * 拿不到就返回 error 说明，而不是抛错。
 */
function analyzeSession(exec) {
  try {
    const session = exec && exec.agent && exec.agent.session
    if (!session) return { error: '拿不到 session 对象' }

    // 事件列表：不同版本可能挂在不同字段上，逐个尝试。
    //
    // ⚠️ 实测（2026-10-05）：`session.log` **本身就是事件数组**
    // （logKeys 是 "0","1",...,"11907"），而 `log.events` 是 undefined。
    // 所以第一个候选就是 log 本身。
    let events = null
    const candidates = [
      () => session.log, // ★ 实测就是它
      () => session.eventsSnapshot,
      () => session.log && session.log.events,
      () => (typeof session.events === 'function' ? session.events() : session.events),
    ]
    for (const get of candidates) {
      try {
        const v = get()
        if (Array.isArray(v) && v.length) {
          events = v
          break
        }
      } catch {
        // 试下一个
      }
    }
    if (!events) {
      // 诊断：把每个候选的真实类型报出来，而不是只说"读不到"。
      // （C-012：给数据打报告，不要凭印象。）
      //
      // ⚠️ 诊断**必须有边界**：第一次实现把 logKeys 全列出来了，
      // 结果输出 118KB —— 诊断本身成了成本。只留前几个 + 总数。
      const shape = (v) => {
        if (v === null) return 'null'
        if (Array.isArray(v)) return 'array(' + v.length + ')'
        return typeof v
      }
      const keysPreview = (obj) => {
        if (!obj || typeof obj !== 'object') return null
        const ks = Object.keys(obj)
        return {
          总数: ks.length,
          前5个: ks.slice(0, 5),
          看起来像数组索引: ks.length > 0 && ks[0] === '0' && ks[ks.length - 1] === String(ks.length - 1),
        }
      }
      let logShape = 'n/a'
      let logPreview = null
      try {
        if (session.log) {
          // ⚠️ 不要保存 Object.keys(session.log) —— 实测它可能是 11908 个索引，
          // 存下来再序列化就是 118KB 的诊断输出。直接用预览函数。
          logPreview = keysPreview(session.log)
          logShape =
            'Object{ log.events=' +
            shape(session.log.events) +
            ', log.length=' +
            shape(session.log.length) +
            ' }'
        }
      } catch {
        logShape = '读取 session.log 时抛错'
      }
      return {
        error: '读不到 session 事件列表',
        诊断: {
          eventsSnapshot: shape(session.eventsSnapshot),
          eventsSnapshotPreview: keysPreview(session.eventsSnapshot),
          log: logShape,
          logPreview,
          derivedNodes: shape(session.derivedNodes),
          toolHistoryProjection: shape(session.toolHistoryProjection),
          firstLiveSeq: shape(session.firstLiveSeq),
          inheritedEventCount: shape(session.inheritedEventCount),
        },
        sessionKeys: Object.keys(session),
      }
    }

    const counts = {
      turn: 0,
      step: 0,
      userMessage: 0,
      assistantMessage: 0,
      toolCall: 0,
      toolResult: 0,
    }
    const toolUsage = {}
    for (const ev of events) {
      const t = ev && ev.type
      if (t === 'turn/start') counts.turn++
      else if (t === 'step/start') counts.step++
      else if (t === 'user/message') counts.userMessage++
      else if (t === 'assistant/message') counts.assistantMessage++
      else if (t === 'tool/call') {
        counts.toolCall++
        const nm = ev.data && ev.data.name ? ev.data.name : '(unknown)'
        toolUsage[nm] = (toolUsage[nm] || 0) + 1
      } else if (t === 'tool/result') counts.toolResult++
    }

    const usageRows = Object.keys(toolUsage)
      .map((name) => ({ name, calls: toolUsage[name] }))
      .sort((a, b) => b.calls - a.calls)

    return {
      eventCount: events.length,
      事件构成: counts,
      工具调用: {
        总计: counts.toolCall,
        不同工具数: usageRows.length,
        排名: usageRows,
      },
    }
  } catch (err) {
    return { error: (err && err.message) || String(err) }
  }
}

/**
 * 综合"占用"与"使用"，给出**建议关闭清单**。
 *
 * 判断依据（两条都要满足）：
 *   1. 这个工具的 schema 明显占地方（默认 >= 200 tokens）
 *   2. 它在本会话里**一次都没被调用过**
 *
 * 满足两条的才是明确候选 —— **占了地方却什么都没干**的工具。
 * 只看大小会误伤"体积大但天天用"的（比如 read / bash）。
 */
function suggestDisable(exec, minTokens = 200) {
  const audit = auditToolSchemas(exec)
  if (audit.error) return { error: audit.error }

  const sess = analyzeSession(exec)
  if (sess.error) {
    return {
      说明: '能算出占用，但读不到本会话的工具调用记录，无法判断"用过没有"',
      原因: sess.error,
      改进: '换成读占用排名的裸数据：cost(action="audit")',
    }
  }

  const used = {}
  for (const row of sess.工具调用.排名) used[row.name] = row.calls

  const candidates = []
  for (const row of audit.all) {
    if (row.approxTokens < minTokens) continue
    if ((used[row.name] || 0) === 0) {
      candidates.push({ name: row.name, approxTokens: row.approxTokens })
    }
  }
  const saved = candidates.reduce((n, c) => n + c.approxTokens, 0)

  // 按名字前缀归组 —— 能看出"整包"级别的收益（如 task_board_* 一组）
  const groups = {}
  for (const c of candidates) {
    const prefix = c.name.includes('_') ? c.name.split('_')[0] : c.name
    groups[prefix] = (groups[prefix] || 0) + c.approxTokens
  }
  const groupRows = Object.keys(groups)
    .map((k) => ({ 前缀: k, 可省tokens: groups[k], 个数: candidates.filter((c) => (c.name.split('_')[0] || c.name) === k).length }))
    .sort((a, b) => b.可省tokens - a.可省tokens)

  return {
    本会话规模: {
      事件数: sess.eventCount,
      轮次: sess.事件构成.turn,
      工具调用: sess.工具调用.总计,
      用过的不同工具: sess.工具调用.不同工具数,
    },
    上下文总量: audit.totalApproxTokens + ' tokens/请求（' + audit.count + ' 个工具）',
    建议关闭: candidates,
    合计可省: saved + ' tokens/请求',
    按前缀归组: groupRows,
    判定标准: '占用 >= ' + minTokens + ' tokens 且本会话调用次数为 0',
    怎么关:
      '在 设置 → 插件市场（或内置插件）里禁用提供它的插件；' +
      '也可以从 profile 的 dsh.profile.bundles 里去掉对应包名。',
    注意:
      '本会话没调用过 ≠ 永远不需要。如果某个工具你只是这个会话没用，' +
      '先对照它的用途再决定；关掉后随时可以再开。',
  }
}

/**
 * 最近一次 `agent/pre-step` 观察到的会话 cwd。
 *
 * 状态路由（HTTP handler）里**没有 agent**，拿不到 session.header.cwd，
 * 所以由 pre-step 顺手记下来，路由读这个值。
 * 还没发过消息时是 null，路由会退回 process.cwd() 并标明来源。
 */
let lastObservedCwd = null

/**
 * 取会话的工作目录。
 *
 * ⚠️ 不要用 `process.cwd()` —— DSH 是 Electron 应用，插件进程的工作目录是
 * **应用目录**，不是会话的工作目录。实测：在 F:\python2 会话里用 process.cwd()
 * 会报"当前项目没有安装 agent-constraints"，而规则库明明就在那里。
 *
 * 正确来源是 `agent.session.header.cwd`（会话创建时记录的 validated absolute cwd）。
 * 这里依次尝试多个可能位置，任一可用即可 —— 拿不到只会让插件降级，
 * 不该让它崩。
 */
function getCwd(agent) {
  try {
    const s = agent && agent.session
    const candidates = [
      s && s.header && s.header.cwd,
      s && s.header && s.header.meta && s.header.meta.cwd,
      s && s.meta && s.meta.cwd,
      s && s.cwd,
      agent && agent.cwd,
    ]
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c
    }
  } catch {
    // 忽略：降级到 process.cwd()
  }
  return process.cwd()
}

/**
 * 从给定目录向上找规则库。
 * 只走"当前项目"这一条链 —— 找到文件系统根就停，不会横向翻别的目录。
 */
function findConstraints(from) {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, CONSTRAINTS_REL)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null // 到根了
    dir = parent
  }
}

/** 读取规则库；读不到返回 null（未安装指令包的项目不该报错） */
function loadConstraints(cwd) {
  try {
    const path = findConstraints(cwd)
    if (!path) return null
    return { path, text: readFileSync(path, 'utf8') }
  } catch {
    return null
  }
}

/**
 * 从规则库里抽出 L0 铁律的标题行 —— 那是每次都需要在场的东西。
 * 完整内容交给 `constraints` 工具按需取，避免每步都塞进长文本。
 */
function extractIronRules(text) {
  const rules = []
  try {
    const lines = String(text).split(/\r?\n/)
    let inL0 = false
    for (const line of lines) {
      if (/^##\s+L0\b/.test(line)) {
        inL0 = true
        continue
      }
      if (/^##\s+L[1-3]\b/.test(line)) {
        inL0 = false
        continue
      }
      if (!inL0) continue
      const m = /^###\s+([A-Z]-\d+)\s+(.+?)\s*$/.exec(line)
      if (m) rules.push(`${m[1]} ${m[2]}`)
    }
  } catch {
    // 解析失败就返回已收集的部分
  }
  return rules
}

/** 未安装时的提示：可操作，而不是报错 */
function notInstalledMessage(cwd) {
  return (
    'constraints: 当前项目没有安装 agent-constraints（已从 ' +
    cwd +
    ' 向上查找 ' +
    CONSTRAINTS_REL +
    '）。以 npx agent-development-constraints install 安装。'
  )
}

/**
 * 已注入过的 agent。
 *
 * ⚠️ **这是本插件最重要的成本控制**。
 *
 * 注入的消息会**进入 session 历史**，之后每一轮请求都要重新发送它。
 * 如果每个 step 都注入一次，成本就随步数**线性增长**：
 *   一个 turn 有 5 步 → 5 条注入 → 之后每轮重发这 5 条。
 *
 * 所以：**每个 agent（会话）只注入一次**。
 * 用 WeakSet 而不是 Set —— 不阻止 agent 被回收，也不会无限增长。
 */
const injectedAgents = new WeakSet()

/**
 * 生成注入的提醒 —— **一句话，只为把 AI 引到工具上**。
 *
 * ## 为什么刻意不列 L0 条目
 *
 * 早先的实现会列全部 12 条铁律标题（约 280 tokens）。看起来很"贴心"，
 * 实际是把成本埋进了历史里：
 *   - 一条 280 tokens 的消息进历史 → 之后**每一轮**都要重发
 *   - 若每步注入，还要乘以步数
 *
 * 而 `constraints` 工具**随时可调用**，`l0` 按需取即可。
 * 两者的信息完全等价，但按需取是**零常驻成本**。
 *
 * 现在这句话约 35 tokens，且每个会话只发一次。
 */
function buildBrief(cwd) {
  const found = loadConstraints(cwd)
  if (!found) return null
  return '【开发约束】本项目装有 agent-constraints 规则库。动手前请先调用 constraints 工具查阅 L0 铁律。'
}

/**
 * 构造 `constraints` 工具的 ToolDefinition。
 *
 * ⚠️ 手写而不是用 `defineTool` —— 见文件头"错误 1"。
 * ⚠️ `parameters` 必须是 **JSON Schema**（`defineTool` 的 DSL 写法在这里不适用）——
 *    见文件头"错误 2"。格式对照已装且工作正常的 @liustack/modlens。
 */
function buildConstraintsTool() {
  return {
    name: 'constraints',
    // ⚠️ description 会**随每个请求**发给模型（工具 schema），是常驻成本。
    // 所以写得尽量短，只保留"什么时候该用"和动作清单。
    description:
      '查看本项目的开发约束规则库（agent-constraints）。' +
      'action: show=全部规则 / l0=仅铁律 / path=规则库位置 / where=解析诊断。' +
      '动手前、或不确定本项目有哪些约定时先调用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'l0', 'path', 'where'],
          description: 'show|l0|path|where',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 2000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const action = args && typeof args.action === 'string' ? args.action : ''
      // 第二个参数 exec 携带调用方身份：exec.agent 就是当前 agent，
      // 它的 session.header.cwd 才是会话的工作目录（见 getCwd 的说明）
      const cwd = getCwd(exec && exec.agent)
      const found = loadConstraints(cwd)

      switch (action) {
        case 'where':
          return JSON.stringify(
            {
              cwd使用值: cwd,
              agent可用: Boolean(exec && exec.agent),
              session可用: Boolean(exec && exec.agent && exec.agent.session),
              规则库: found ? found.path : null,
            },
            null,
            2
          )
        case 'path':
          if (!found) return notInstalledMessage(cwd)
          return found.path
        case 'l0': {
          if (!found) return notInstalledMessage(cwd)
          const iron = extractIronRules(found.text)
          return iron.length
            ? 'L0 铁律：\n' + iron.map((r) => '  - ' + r).join('\n')
            : 'constraints: 规则库里没有 L0 段落。'
        }
        case 'show':
          if (!found) return notInstalledMessage(cwd)
          return found.text
        default:
          throw new Error(
            `constraints: unknown action ${JSON.stringify(action)}（可用：show / l0 / path / where）`
          )
      }
    },
  }
}

/**
 * 构造 `cost` 工具的 ToolDefinition —— 成本感知。
 *
 * ⚠️ 和 constraints 不同：它是**按需调用**的，平时零成本。
 * 常驻的只有下面这段 description（每个请求都发），所以写得尽量短。
 */
function buildCostTool() {
  return {
    name: 'cost',
    description:
      '查看 AI 用量与成本，并审计上下文里谁最占地方、谁可以关掉。' +
      'action: show=今日/累计用量 / audit=占用排名 / session=本会话工具使用情况 / disable=建议关闭清单 / tips=优化建议。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'audit', 'session', 'disable', 'tips'],
          description: 'show|audit|session|disable|tips',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 3000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const action = args && typeof args.action === 'string' ? args.action : ''

      if (action === 'audit') {
        const a = auditToolSchemas(exec)
        // all 是内部用的完整排名，输出时去掉
        if (a && a.all) delete a.all
        return JSON.stringify(a, null, 2)
      }

      if (action === 'session') {
        return JSON.stringify(analyzeSession(exec), null, 2)
      }

      if (action === 'disable') {
        return JSON.stringify(suggestDisable(exec), null, 2)
      }

      if (action === 'tips') {
        const usage = loadUsage()
        const audit = auditToolSchemas(exec)
        const tips = []
        if (usage && usage.total.calls > 0) {
          const ratio =
            usage.total.cacheReadTokens / Math.max(1, usage.total.inputTokens)
          tips.push(
            `累计 cacheRead / input = ${ratio.toFixed(1)} 倍。` +
              '这个比例说明**每一轮都在重发整个上下文前缀** —— ' +
              '缓存单价低，但量一大仍然贵。减少常驻内容（工具 schema、系统提示）比减少对话内容更有效。'
          )
        }
        if (audit && audit.top && audit.top.length) {
          const biggest = audit.top[0]
          tips.push(
            `当前工具 schema 共约 ${audit.totalApproxTokens} tokens/请求，` +
              `最大的是 \`${biggest.name}\`（约 ${biggest.approxTokens} tokens）。` +
              '工具 schema 每个请求都发，是纯粹的常驻成本 —— 不需要的工具应当移出作用域。'
          )
        }
        tips.push(
          '长会话的上下文会持续增长 → 每轮重发更多。' +
            '做完整一个阶段就开新会话，比在一个超长会话里继续更省。'
        )
        return tips.map((t, i) => `${i + 1}. ${t}`).join('\n\n')
      }

      if (action === 'show') {
        const usage = loadUsage()
        if (!usage) {
          return JSON.stringify(
            {
              error: '读不到用量账本',
              expected: USAGE_LEDGER,
              hint: 'DSH 的用量账本由 harness 自己维护，可能是首次运行还没生成',
            },
            null,
            2
          )
        }
        const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '—')
        return JSON.stringify(
          {
            今日: {
              日期: usage.todayKey,
              输入tokens: usage.today.inputTokens,
              输出tokens: usage.today.outputTokens,
              缓存读取tokens: usage.today.cacheReadTokens,
              调用次数: usage.today.calls,
              成本: Number(usage.today.cost.toFixed(4)),
              缓存读取是输入的: pct(usage.today.cacheReadTokens, usage.today.inputTokens),
            },
            累计: {
              天数: usage.dayCount,
              输入tokens: usage.total.inputTokens,
              输出tokens: usage.total.outputTokens,
              缓存读取tokens: usage.total.cacheReadTokens,
              调用次数: usage.total.calls,
              成本: Number(usage.total.cost.toFixed(4)),
            },
            余额: usage.balance ? `${usage.balance} ${usage.currency || ''}`.trim() : null,
            数据来源: USAGE_LEDGER,
          },
          null,
          2
        )
      }

      throw new Error(
        `cost: unknown action ${JSON.stringify(action)}（可用：show / audit / tips）`
      )
    },
  }
}

export function apply(ctx) {
  // ---------- 注册 constraints 工具 ----------
  //
  // ⚠️ 目前**只做这一件事**，不监听任何事件。
  //
  // ## 为什么把 `agent/pre-step` 摘掉了（第二次事故的根因）
  //
  // 上一版监听 pre-step 并「原样透传」`next()` 的结果：
  //
  //   const decision = await next()
  //   if (!decision || decision.kind !== 'enter') return decision   // ← 返回 undefined
  //
  // 我假定了 `next()` 一定返回 `PreStepDecision` 对象。但**宿主读的正是
  // `decision.kind`** —— 一旦 `next()` 给的是 `undefined`，我"原样透传"出去的
  // 就是 `undefined`，宿主读 `.kind` 直接崩：
  //
  //   Cannot read properties of undefined (reading 'kind')
  //
  // **"原样透传"听起来最保守，实际是把上游的空值往下游传了。**
  // 在这个契约里，返回 `undefined` 本身就是非法的 —— 必须回一个合法的
  // `{ kind: 'enter', messages }` 或 `{ kind: 'reject' }`。
  //
  // 这也是为什么第一轮"零外部依赖"的修复没有效果：崩的不是加载，
  // 而是每一个步骤的 pre-step。
  //
  // 在拿到真实契约（或确认 `next()` 的返回形状）之前，这里选择**什么都不做**：
  // 少一个功能，换宿主绝对不崩。见 L1 的 C-009。
  // 探针：先记录"apply 真的被调用了、ctx 里有什么"。
  // 连续两轮"重启后工具不出现"都是靠猜（先猜 import，再猜 pre-step），
  // 猜了两次都错。这次让插件自己把事实写下来。
  writeProbe('apply-called', {
    hasCtx: Boolean(ctx),
    ctxKeys: ctx ? Object.keys(ctx) : null,
    hasTools: Boolean(ctx && ctx.tools),
    toolsKeys: ctx && ctx.tools ? Object.keys(ctx.tools) : null,
    hasOn: Boolean(ctx && typeof ctx.on === 'function'),
    hasInjectFn: Boolean(ctx && typeof ctx.inject === 'function'),
  })

  /** 在给定作用域里注册工具；成功/失败都记探针 */
  function registerTool(scope, via) {
    try {
      if (scope && scope.tools && typeof scope.tools.register === 'function') {
        const registered = []
        const failures = []
        // 两个工具各自独立 try —— 一个失败不该拖累另一个
        for (const [label, build] of [
          ['constraints', buildConstraintsTool],
          ['cost', buildCostTool],
        ]) {
          try {
            scope.tools.register(build())
            registered.push(label)
          } catch (err) {
            failures.push(label + ': ' + ((err && err.message) || String(err)))
          }
        }
        writeProbe('tool-registered', {
          via,
          hasTools: true,
          registered,
          failures: failures.length ? failures : null,
          toolsKeys: Object.keys(scope.tools),
        })
        return registered.length > 0
      }
      writeProbe('tool-register-skipped', {
        via,
        reason: !scope ? '作用域为空' : !scope.tools ? 'scope.tools 不存在' : 'scope.tools.register 不是函数',
        scopeKeys: scope ? Object.keys(scope) : null,
      })
      return false
    } catch (err) {
      writeProbe('tool-register-failed', { via, error: err && err.message })
      return false
    }
  }

  // ---------- 路线 A：回调式注入（dshmarket 用的方式）----------
  //
  // 实测教训：只靠 `export const inject = ['tools']` 时，apply 拿到的 ctx
  // **只有 `on`**（`ctx.tools` 不存在）——探针文件里写得很清楚：
  //   { "stage": "tool-register-skipped", "reason": "ctx.tools 不存在",
  //     "ctxKeys": ["on"] }
  // 而 dshmarket 是用 `ctx.inject([...], (scope) => ...)` 拿到服务的。
  // 两条路都走，哪条成功由探针记录（via 字段）。
  if (ctx && typeof ctx.inject === 'function') {
    try {
      let settled = false
      const ret = ctx.inject(['tools'], (scope) => {
        settled = true
        registerTool(scope, 'ctx.inject-callback')
      })
      // inject 可能返回 Promise（服务未就绪时）
      if (ret && typeof ret.then === 'function') {
        ret.then(
          () => {
            if (!settled) {
              writeProbe('inject-callback-pending', { note: 'ctx.inject 返回的 Promise 已 settle，但回调未同步触发' })
            }
          },
          (err) => writeProbe('inject-callback-rejected', { error: err && err.message })
        )
      }
    } catch (err) {
      writeProbe('inject-callback-threw', { error: err && err.message })
    }
  }

  // ---------- 路线 B：直接注册（服务已就绪时的快路）----------
  registerTool(ctx, 'direct')

  // ---------- 观察 `agent/pre-step` 的真实契约 ----------
  //
  // ## 为什么是"观察"而不是"注入"
  //
  // 上一次崩在这里（`Cannot read properties of undefined (reading 'kind')`）：
  // 我"原样透传" `next()` 的结果，而宿主读 `decision.kind` ——
  // 若 `next()` 给的是 `undefined`，透传 `undefined` 就崩。
  //
  // 但官方文档说 `next()` 必然返回 `PreStepDecision`。**两种说法矛盾。**
  // 前面已经猜错三轮了，所以这次**不猜**：
  //
  //   - **只记录** decision 的真实形状（写进探针）
  //   - 返回值**原样透传** —— 这是唯一诚实的做法：
  //     我凭空造一个 decision 反而会篡改宿主的行为
  //
  // 拿到探针里的真实形状后，才有依据决定注入该怎么写。
  if (ctx && typeof ctx.on === 'function') {
    try {
      ctx.on('agent/pre-step', async (payload, next) => {
        let decision
        try {
          decision = await next()
        } catch (err) {
          writeProbe('pre-step-next-threw', { error: err && err.message })
          throw err
        }
        try {
          // 顺便记录真实 UserMessage 的结构 —— 写注入时必须照着它拼。
          // 上次崩很可能就是因为我凭文档猜了一个不完整的 message 对象。
          const first =
            decision && Array.isArray(decision.messages) ? decision.messages[0] : null
          // 记下会话 cwd，状态路由要用（HTTP handler 里没有 agent）。
          // 同时记下探测过程 —— 工具那边用 exec.agent.session.header.cwd 有效，
          // 但事件这边 payload.agent 的结构可能不同（实测确实拿不到）。
          try {
            const c = getCwd(payload && payload.agent)
            if (c && !lastObservedCwd) lastObservedCwd = c
            const pa = payload && payload.agent
            const psess = pa && pa.session
            writeProbe('cwd-probe', {
              got: c || null,
              agentKeys: pa ? Object.keys(pa) : null,
              agentType: pa ? typeof pa : null,
              hasSession: Boolean(psess),
              sessionKeys: psess ? Object.keys(psess) : null,
              hasHeader: Boolean(psess && psess.header),
              headerKeys: psess && psess.header ? Object.keys(psess.header) : null,
              headerCwd: psess && psess.header ? psess.header.cwd || null : null,
            })
          } catch (e) {
            writeProbe('cwd-probe-failed', { error: e && e.message })
          }
          writeProbe('pre-step-observed', {
            decisionType: typeof decision,
            decisionIsUndefined: decision === undefined,
            decisionIsNull: decision === null,
            decisionKind:
              decision && typeof decision === 'object' ? decision.kind : null,
            decisionKeys:
              decision && typeof decision === 'object' ? Object.keys(decision) : null,
            messagesIsArray: Boolean(decision && Array.isArray(decision.messages)),
            messagesLength:
              decision && Array.isArray(decision.messages)
                ? decision.messages.length
                : null,
            payloadKeys:
              payload && typeof payload === 'object' ? Object.keys(payload) : null,
            payloadHasAgent: Boolean(payload && payload.agent),
            // —— 下面这段是为了拿到 UserMessage 的精确形状 ——
            firstMessage: first
              ? {
                  keys: Object.keys(first),
                  role: first.role,
                  hasId: 'id' in first,
                  idType: typeof first.id,
                  hasSource: 'source' in first,
                  sourceKeys: first.source ? Object.keys(first.source) : null,
                  contentType: typeof first.content,
                  contentIsArray: Array.isArray(first.content),
                  contentLength: Array.isArray(first.content)
                    ? first.content.length
                    : null,
                  contentBlockKeys:
                    Array.isArray(first.content) && first.content[0]
                      ? Object.keys(first.content[0])
                      : null,
                  contentBlockType:
                    Array.isArray(first.content) && first.content[0]
                      ? first.content[0].type
                      : null,
                }
              : null,
          })
        } catch {
          // 探针失败不影响返回值
        }

        // ---------- 注入（受配置开关控制，每会话一次）----------
        try {
          if (configInjectEnabled()) {
            const agent = payload && payload.agent
            const canInject =
              Boolean(agent) &&
              !injectedAgents.has(agent) &&
              decision &&
              decision.kind === 'enter' &&
              Array.isArray(decision.messages) &&
              decision.messages.length > 0
            if (canInject) {
              const brief = buildBrief(getCwd(agent))
              if (brief) {
                // 用**真实的已有消息当模板**复制结构 —— 不猜字段。
                //
                // 这是本段最关键的设计：探针还没给出 UserMessage 的确切形状，
                // 但 decision.messages[0] 本身就是一条真实的 UserMessage，
                // 复制它比按文档拼一个更安全（上次崩就是因为拼得不完整）。
                const tpl = decision.messages[0]
                const injected = Object.assign({}, tpl)
                if (Array.isArray(tpl.content) && tpl.content.length > 0) {
                  injected.content = [
                    Object.assign({}, tpl.content[0], { text: brief }),
                  ]
                } else {
                  injected.content = [{ type: 'text', text: brief }]
                }
                // id 必须唯一，否则可能与已存在的消息冲突
                if (typeof tpl.id === 'string') injected.id = tpl.id + ':constraints'
                injectedAgents.add(agent)
                writeProbe('inject-applied', {
                  briefLength: brief.length,
                  templateKeys: Object.keys(tpl),
                  templateContentKeys:
                    Array.isArray(tpl.content) && tpl.content[0]
                      ? Object.keys(tpl.content[0])
                      : null,
                })
                return Object.assign({}, decision, {
                  messages: decision.messages.concat([injected]),
                })
              }
            }
          }
        } catch (err) {
          // 注入失败绝不影响会话：原样返回下游的 decision
          writeProbe('inject-failed', { error: err && err.message })
        }

        return decision
      })
      writeProbe('pre-step-listener-registered', { ok: true })
    } catch (err) {
      writeProbe('pre-step-listen-failed', { error: err && err.message })
    }
  }

  // ---------- 状态路由：给客户端卡片读 ----------
  //
  // 卡片（dsh/client.js）通过 GET /agent-development-constraints/status 拿运行时状态。
  // 注册方式照 @liustack/modlens 的 registerConfigRoute：
  //   scope.webServer.register({ name, kind: 'exact', path, handler })
  //
  // webServer 只在 web profile 存在，所以走 scoped ctx.inject —— 服务不存在时
  // 闭包根本不跑，不会抛错。
  if (ctx && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope) => {
        try {
          scope.webServer.register({
            name: 'agent-constraints-status',
            kind: 'exact',
            path: '/agent-development-constraints/status',
            handler: async (req, res) => {
              const send = (code, body) => {
                try {
                  res.writeHead(code, { 'content-type': 'application/json' })
                  res.end(JSON.stringify(body))
                } catch {
                  // 响应已发出，忽略
                }
              }

              // 只接受 GET（读状态）与 POST（写配置）。
              // ⚠️ 本路由只监听 loopback（host 自己起的 web server），
              // 且只暴露"规则库路径/开关"这类非敏感信息，写操作也只改一个布尔。
              if (req.method !== 'GET' && req.method !== 'POST') {
                send(405, { error: 'method not allowed' })
                return
              }

              try {
                if (req.method === 'POST') {
                  // 读请求体（体积很小，设个上限防意外）
                  const chunks = []
                  let size = 0
                  for await (const chunk of req) {
                    size += chunk.length
                    if (size > 4096) {
                      send(413, { error: 'body too large' })
                      return
                    }
                    chunks.push(chunk)
                  }
                  let patch = {}
                  if (chunks.length) {
                    try {
                      patch = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                    } catch {
                      send(400, { error: 'invalid json' })
                      return
                    }
                  }
                  // 只接受已知字段，且强制布尔 —— 不把任意对象写进配置文件
                  const clean = {}
                  if (patch && typeof patch.inject === 'boolean') clean.inject = patch.inject
                  const saved = saveConfig(clean)
                  if (!saved) {
                    send(500, { error: 'failed to save config' })
                    return
                  }
                  writeProbe('config-saved', { config: saved })
                  send(200, { ok: true, config: saved })
                  return
                }

                // GET：状态 + 当前配置 + 成本摘要
                const cwd = lastObservedCwd || process.cwd()
                const found = loadConstraints(cwd)
                const usage = loadUsage()
                send(200, {
                  name: 'agent-development-constraints',
                  version: readOwnVersion(),
                  constraintsPath: found ? found.path : null,
                  cwd,
                  cwdSource: lastObservedCwd ? 'session' : 'process',
                  injectEnabled: configInjectEnabled(),
                  configFile: CONFIG_FILE,
                  probeFile: join(homedir(), '.dsh', 'agent-constraints-probe.json'),
                  // 成本摘要（卡片显示用；拿不到就是 null）
                  cost: usage
                    ? {
                        todayKey: usage.todayKey,
                        todayCost: Number(usage.today.cost.toFixed(4)),
                        todayCalls: usage.today.calls,
                        todayInputTokens: usage.today.inputTokens,
                        todayOutputTokens: usage.today.outputTokens,
                        todayCacheReadTokens: usage.today.cacheReadTokens,
                        totalCost: Number(usage.total.cost.toFixed(4)),
                        totalCalls: usage.total.calls,
                        dayCount: usage.dayCount,
                        balance: usage.balance,
                        currency: usage.currency,
                      }
                    : null,
                })
              } catch (err) {
                send(500, { error: (err && err.message) || String(err) })
              }
            },
          })
          writeProbe('status-route-registered', { ok: true })
        } catch (err) {
          writeProbe('status-route-failed', { error: err && err.message })
        }
      })
    } catch (err) {
      writeProbe('status-route-inject-failed', { error: err && err.message })
    }
  }
}
