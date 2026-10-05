/**
 * DSH 插件入口：把项目的开发约束接入 harness。
 *
 * ## 为什么要有插件形态
 * 指令包形态下，约束只是"躺在项目里的文件"—— AI 得**记得去读**才会看到。
 * 插件形态下，约束在每一步之前自动进入上下文，不依赖任何人记得。
 *
 * ## 两个作用
 *   ① 监听 `agent/pre-step` —— 每步之前把 L0 铁律摘要并入本步消息（被动生效）
 *   ② 注册 `constraints` 工具 —— AI 可以主动查看完整规则库
 *
 * ## 两个已经踩过的坑（写在这里，避免以后自己再踩）
 *
 * **坑 1：不要用 `process.cwd()` 找项目目录。**
 * DSH 是 Electron 应用，插件进程的工作目录是**应用目录**，不是会话的工作目录。
 * 正确来源是 `agent.session.header.cwd` —— 会话创建时记录了 validated absolute cwd。
 * 实测：用 process.cwd() 时工具在 F:\python2 会话里报"未安装规则库"。
 *
 * **坑 2：`agent/pre-step` 的返回值是 `PreStepDecision`，消息是 `UserMessage[]`。**
 *   type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }
 * 一开始我按 ContentBlock 的形状（{ type: 'text' }）去 unshift，那是**错的** ——
 * 这里要的是带 `role: 'user'` 与 `content` 的 UserMessage。
 *
 * ## 隐私承诺（见 PRIVACY.md）
 *   - 零网络：只读本地文件
 *   - 只读当前项目：从会话 cwd 向上找 agent-constraints/
 *   - 不写任何东西：本文件没有任何 fs 写操作
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const name = 'agent-development-constraints'

// 需要工具注册表就绪才能注册工具；事件监听不依赖任何服务
export const inject = ['tools']

/** 规则库在整个项目里的相对位置 */
const CONSTRAINTS_REL = join('agent-constraints', 'core', 'constraints.md')

/**
 * 取会话的工作目录。
 *
 * 依次尝试多个可能的位置，任一可用即可 —— 这里**故意**写得宽容，
 * 因为拿不到目录只会让插件降级（提示"未安装"），而不该让它崩掉。
 * 最后才退回 process.cwd()（在非 Electron 场景下它是对的）。
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
 * 只走"当前项目"这一条链 —— 找到文件系统根就停，不会横向去翻别的目录。
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
  const path = findConstraints(cwd)
  if (!path) return null
  try {
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
  const lines = text.split(/\r?\n/)
  const rules = []
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
  return rules
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

export function apply(ctx) {
  // ---------- ① 被动生效：每步之前并入一条提醒 ----------
  //
  // `agent/pre-step` 是 waterfall：必须调用 next() 委托下游（省略会短路整条链），
  // 返回值必须是 PreStepDecision。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      // 只在本步正常进入时追加；reject 要原样透传
      if (!decision || decision.kind !== 'enter') return decision
      const brief = buildBrief(getCwd(payload && payload.agent))
      if (!brief) return decision

      // 追加在**末尾**：人工输入应当排在最前，插件提示放后面
      const extra = {
        role: 'user',
        content: [{ type: 'text', text: brief }],
      }
      return { ...decision, messages: [...(decision.messages || []), extra] }
    } catch {
      // 注入失败绝不影响会话本身
      return decision
    }
  })

  // ---------- ② 主动查询：注册 constraints 工具 ----------
  ctx.tools.register(defineTool({
    name: 'constraints',
    description:
      '查看本项目的开发约束规则库（agent-constraints）。' +
      'action=show 返回完整规则库正文；action=l0 只返回 L0 铁律；' +
      'action=path 返回规则库文件路径；action=where 返回解析诊断（用哪个目录找到的）。' +
      '当你不确定本项目有哪些约定、或准备改动结构/配置时，先调用它。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['show', 'l0', 'path', 'where'],
        description: 'show=全部规则；l0=仅铁律；path=规则库位置；where=解析诊断。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // 第二个参数 exec 携带调用方身份：exec.agent 就是当前 agent，
    // 它的 session.header.cwd 才是会话的工作目录（见文件头的坑 1）
    execute: (args, exec) => {
      const cwd = getCwd(exec && exec.agent)
      const found = loadConstraints(cwd)

      if (args.action === 'where') {
        return Promise.resolve(
          JSON.stringify(
            {
              cwd使用值: cwd,
              agent可用: Boolean(exec && exec.agent),
              session可用: Boolean(exec && exec.agent && exec.agent.session),
              规则库: found ? found.path : null,
            },
            null,
            2
          )
        )
      }

      if (!found) {
        return Promise.resolve(
          'constraints: 当前项目没有安装 agent-constraints（已从 ' +
            cwd +
            ' 向上查找 ' +
            CONSTRAINTS_REL +
            '）。以 npx agent-development-constraints install 安装。'
        )
      }

      switch (args.action) {
        case 'path':
          return Promise.resolve(found.path)
        case 'l0': {
          const iron = extractIronRules(found.text)
          return Promise.resolve(
            iron.length
              ? 'L0 铁律：\n' + iron.map((r) => '  - ' + r).join('\n')
              : 'constraints: 规则库里没有 L0 段落。'
          )
        }
        case 'show':
          return Promise.resolve(found.text)
        default:
          return Promise.reject(new Error(`constraints: unknown action ${String(args.action)}`))
      }
    },
    timeoutMs: 2000,
  }))
}
