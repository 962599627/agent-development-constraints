/**
 * DSH 插件入口：把项目的开发约束接入 harness。
 *
 * 为什么要有插件形态：
 *   指令包形态下，约束只是"躺在项目里的文件"—— AI 得**记得去读**才会看到。
 *   插件形态下，约束在每一步之前自动进入上下文，不依赖任何人记得。
 *
 * 两个作用：
 *   ① 监听 `agent/pre-step` —— 每步之前把约束摘要送进上下文（被动生效）
 *   ② 注册 `constraints` 工具 —— AI 可以主动查看完整规则库
 *
 * 隐私承诺（见 PRIVACY.md，这里逐条兑现）：
 *   - 零网络：只读本地文件
 *   - 只读当前项目：从 cwd 向上找 agent-constraints/，不越界到其他目录
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
 * 从给定目录向上找规则库。
 * 只走"当前项目"这一条链 —— 找到文件系统根就停，不会横向去翻别的目录。
 */
function findConstraints(from = process.cwd()) {
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
function loadConstraints() {
  const path = findConstraints()
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
    if (/^##\s+L0\b/.test(line)) { inL0 = true; continue }
    if (/^##\s+L[1-3]\b/.test(line)) { inL0 = false; continue }
    if (!inL0) continue
    const m = /^###\s+([A-Z]-\d+)\s+(.+?)\s*$/.exec(line)
    if (m) rules.push(`${m[1]} ${m[2]}`)
  }
  return rules
}

/** 生成每步注入的简短提醒 —— 只放标题，不放大段正文 */
function buildBrief() {
  const found = loadConstraints()
  if (!found) return null
  const iron = extractIronRules(found.text)
  const head = [
    '【开发约束 · 来自 agent-constraints】',
    `规则库：${found.path}`,
  ]
  if (iron.length) {
    head.push('L0 铁律（动手前逐条对照）：')
    for (const r of iron) head.push(`  - ${r}`)
  }
  head.push('需要完整规则、触发条件与检查方法时，调用 constraints 工具。')
  return head.join('\n')
}

export function apply(ctx) {
  // ---------- ① 被动生效：每步之前注入简短提醒 ----------
  // agent/pre-step 的载荷形状在不同版本可能不同，这里做防御式读取：
  // 拿到什么就当提示文本用，拿不到就跳过 —— 插件绝不能因为注入失败而拖垮会话。
  ctx.on('agent/pre-step', async (payload, next) => {
    const proceed = () => (typeof next === 'function' ? next() : undefined)
    const brief = buildBrief()
    if (!brief) return proceed()

    try {
      // waterfall 模式下 next() 返回下游结果；把提醒附加进去
      const downstream = await proceed()
      if (downstream && typeof downstream === 'object') {
        // 常见形状：{ messages: [...] } / { context: [...] }
        for (const key of ['messages', 'context', 'parts']) {
          if (Array.isArray(downstream[key])) {
            downstream[key].unshift({ type: 'text', text: brief })
            return downstream
          }
        }
      }
      return downstream
    } catch {
      // 注入失败不影响会话本身
      return proceed()
    }
  })

  // ---------- ② 主动查询：注册 constraints 工具 ----------
  ctx.tools.register(defineTool({
    name: 'constraints',
    description:
      '查看本项目的开发约束规则库（agent-constraints）。' +
      'action=show 返回完整规则库正文；action=l0 只返回 L0 铁律；' +
      'action=path 返回规则库文件路径。' +
      '当你不确定本项目有哪些约定、或准备改动结构/配置时，先调用它。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['show', 'l0', 'path'],
        description: 'show=全部规则；l0=仅铁律；path=规则库位置。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args) => {
      const found = loadConstraints()
      if (!found) {
        return Promise.resolve(
          'constraints: 当前项目没有安装 agent-constraints（未找到 ' +
          CONSTRAINTS_REL + '）。以 npx agent-development-constraints install 安装。'
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
