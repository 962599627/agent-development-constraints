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

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const name = 'agent-development-constraints'

// 不声明 inject：工具注册表在 apply 时由 harness 挂到 ctx 上，
// 显式 inject 反而会在服务名对不上时让插件卡在 PENDING。
// 用 try/catch 探测 ctx.tools 更宽容。

/** 规则库在整个项目里的相对位置 */
const CONSTRAINTS_REL = join('agent-constraints', 'core', 'constraints.md')

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

/** 生成每步注入的简短提醒 —— 只放标题，不放大段正文 */
function buildBrief(cwd) {
  const found = loadConstraints(cwd)
  if (!found) return null
  const iron = extractIronRules(found.text)
  const lines = ['【开发约束 · 来自 agent-constraints】', `规则库：${found.path}`]
  if (iron.length) {
    lines.push('L0 铁律（动手前逐条对照）：')
    for (const r of iron) lines.push(`  - ${r}`)
  }
  lines.push('需要完整规则、触发条件与检查方法时，调用 constraints 工具。')
  return lines.join('\n')
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
    description:
      '查看本项目的开发约束规则库（agent-constraints）。' +
      'action=show 返回完整规则库正文；action=l0 只返回 L0 铁律；' +
      'action=path 返回规则库文件路径；action=where 返回解析诊断（用哪个目录找到的）。' +
      '当你不确定本项目有哪些约定、或准备改动结构/配置时，先调用它。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'l0', 'path', 'where'],
          description: 'show=全部规则；l0=仅铁律；path=规则库位置；where=解析诊断。',
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

export function apply(ctx) {
  // ---------- ② 注册 constraints 工具 ----------
  // 放在前面：即使事件监听那条路出问题，工具也已经可用。
  try {
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      ctx.tools.register(buildConstraintsTool())
    }
  } catch (err) {
    // 注册失败只让工具不可用，绝不影响会话
    try {
      console.warn('[agent-constraints] 工具注册失败（插件降级，会话不受影响）:', err && err.message)
    } catch {}
  }

  // ---------- ① 每步之前并入一条提醒 ----------
  //
  // `agent/pre-step` 是 waterfall：
  //   'agent/pre-step'(payload: { agent, messages: UserMessage[], turn, step, signal },
  //                   next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  //   type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }
  //
  // 保守策略：先拿下游结果，只有确认形状对、且真的拿到 brief 时才改动；
  // 任何异常 / 任何不确定，都原样把下游结果返回。
  // 这条路径一旦返回错东西，整个会话就会失败（上一次就是这么崩的）。
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      let decision
      try {
        decision = await next()
      } catch (err) {
        // 下游自己抛错就不该由我们吞掉或改写，向上传播
        throw err
      }
      try {
        // 只有确认是本步正常进入、且消息是数组时才介入
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
          return decision
        }
        const brief = buildBrief(getCwd(payload && payload.agent))
        if (!brief) return decision

        // 追加在**末尾**：人工输入应当排在最前，插件提示放后面。
        // 形状必须是 UserMessage（带 role: 'user' 与 content 数组），
        // 不是 ContentBlock —— 这里搞错过一次。
        const extra = {
          role: 'user',
          content: [{ type: 'text', text: brief }],
        }
        return { ...decision, messages: [...decision.messages, extra] }
      } catch (err) {
        try {
          console.warn('[agent-constraints] 注入失败（会话不受影响）:', err && err.message)
        } catch {}
        return decision
      }
    })
  } catch (err) {
    try {
      console.warn('[agent-constraints] pre-step 监听注册失败（插件降级）:', err && err.message)
    } catch {}
  }
}
