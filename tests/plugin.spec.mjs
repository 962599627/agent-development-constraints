/**
 * 插件契约测试
 *
 * ## 这个文件的存在理由（两次真实事故）
 *
 * **事故 1**：顶层 `import { defineTool } from '@deepseek-ai/dsh-tools'`，
 * 而目标 profile 设了 `autoInstallPeers: false` —— peer 依赖不会被安装，
 * 模块解析失败 → 插件 FAILED → 宿主会话崩。
 *
 * **事故 2（更隐蔽）**：`agent/pre-step` 处理器"原样透传" `next()` 的结果：
 *
 *     const decision = await next()
 *     if (!decision || decision.kind !== 'enter') return decision   // ← undefined
 *
 * 宿主读的正是 `decision.kind` —— `next()` 给 `undefined` 时我透传 `undefined`，
 * 宿主读 `.kind` 就崩：`Cannot read properties of undefined (reading 'kind')`。
 *
 * **"原样透传"听起来最保守，实际是把上游的空值往下游传。**
 *
 * 事故 1 修完没解决问题，正是因为崩的不是加载而是每个步骤的 pre-step。
 * 所以现在的策略是：**只注册工具，不监听任何事件**。
 * 本文件里那两条「不得监听」的用例就是防止它被无意加回来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 造一个"已安装指令包"的项目目录，用来验证工具能定位规则库 */
function makeInstalledProject() {
  const dir = mkdtempSync(join(process.env.TEMP || '/tmp', 'adc-test-'))
  const coreDir = join(dir, 'agent-constraints', 'core')
  mkdirSync(coreDir, { recursive: true })
  writeFileSync(
    join(coreDir, 'constraints.md'),
    [
      '# 测试规则库',
      '',
      '## L0 · 铁律',
      '',
      '### R-001 凭据绝不硬编码',
      '- **规则**：只从环境变量读',
      '',
      '### R-002 忽略规则防不住已写进去的值',
      '- **规则**：看内容不看文件名',
      '',
      '## L1 · 协作约定',
      '',
      '### C-001 不该被当成铁律的条目',
      '',
    ].join('\n'),
    'utf8'
  )
  return dir
}

function load() {
  return import(pathToFileURL(join(ROOT, 'index.mjs')).href)
}

/** 造一个假的 ctx，记录注册与监听的调用 */
function makeCtx() {
  const tools = []
  const handlers = {}
  return {
    tools: { register: (t) => tools.push(t) },
    on: (evt, fn) => {
      handlers[evt] = fn
    },
    _tools: tools,
    _handlers: handlers,
  }
}

// ---------------------------------------------------------------------------
// 事故防线（一）：零外部依赖
// ---------------------------------------------------------------------------

test('【事故1】插件不依赖任何外部包，无需 stub 即可加载', async () => {
  const src = readFileSync(join(ROOT, 'index.mjs'), 'utf8')
  const external = [...src.matchAll(/^import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith('node:'))
  assert.deepEqual(
    external,
    [],
    `插件只能 import node: 内置模块，发现外部依赖: ${external.join(', ')}`
  )

  const plugin = await load()
  assert.equal(plugin.name, 'agent-development-constraints')
  assert.equal(typeof plugin.apply, 'function')
})

test('package.json 不声明会阻止安装的 peerDependencies', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.peerDependencies, undefined, '不该声明 peerDependencies')
  assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, '必须声明 dsh.bundle')
})

// ---------------------------------------------------------------------------
// R-011：两个地方说同一件事，就必须有一致性测试
// ---------------------------------------------------------------------------

test('【R-011】VERSION 文件与 package.json.version 必须一致', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const fromFile = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim()
  assert.equal(
    fromFile,
    pkg.version,
    `VERSION（${fromFile}）与 package.json.version（${pkg.version}）不一致 —— 升级时要同时改`
  )
})

test('【R-011】源码里不得硬编码版本号（版本只有一个来源）', () => {
  // 历史：host 的状态路由写 '0.11.0'、client 写 '0.9.0'、VERSION 文件是第三个值。
  // 用户看到卡片一直显示旧版本，因为升级时只改了 VERSION 文件。
  // 现在版本只能来自 VERSION（host 用 readOwnVersion 读取，client 由 /status 上报）。
  const files = [
    { path: join(ROOT, 'index.mjs'), label: 'index.mjs' },
    { path: join(ROOT, 'dsh', 'client.js'), label: 'dsh/client.js' },
  ]
  // 形如 '0.11.0' 或 "0.9.0" 的字符串字面量（排除注释行）
  const versionLiteral = /(['"])\d+\.\d+\.\d+\1/

  for (const f of files) {
    const lines = readFileSync(f.path, 'utf8').split(/\r?\n/)
    const offenders = []
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      // 跳过注释：// 行、块注释、以及 JSDoc 的 * 行
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      ) {
        return
      }
      const code = line.split('//')[0]
      if (!code.trim()) return
      const m = versionLiteral.exec(code)
      if (!m) return
      // '0.0.0' 是"读不到版本"时的兜底值，允许
      if (m[0].includes('0.0.0')) return
      offenders.push(`第 ${i + 1} 行: ${trimmed}`)
    })
    assert.deepEqual(
      offenders,
      [],
      `${f.label} 里出现了硬编码版本号（应当只从 VERSION 读）:\n` + offenders.join('\n')
    )
  }
})

test('host 通过读 VERSION 文件取版本，而不是写死', () => {
  const src = readFileSync(join(ROOT, 'index.mjs'), 'utf8')
  assert.match(src, /function readOwnVersion/, '应有 readOwnVersion 函数')
  assert.match(src, /readOwnVersion\(\)/, '状态路由应调用它')
})

test('【R-011】README / docs 里不得硬编码版本号', () => {
  // ------------------------------------------------------------------
  // 为什么补这一条（2026-10-05，用户发现的）
  //
  // 上面那条"源码里不得硬编码版本号"只扫了 index.mjs 与 dsh/client.js，
  // **没扫 README** —— 于是 README 里写着 `Version: 0.7.0`，
  // 而 VERSION 早就走到 0.25，十几个版本没人同步。
  // 用户在仓库首页看到的永远是 0.7.0，直接问"不是更新了吗？"
  //
  // 这就是 R-014 说的那件事：**一致性检查的范围太窄**，
  // 会给出"我们有测试覆盖"的虚假信心。
  // ------------------------------------------------------------------
  const targets = [
    join(ROOT, 'README.md'),
    join(ROOT, 'README.zh-CN.md'),
    join(ROOT, 'CONTRIBUTING.md'),
  ]
  const docsDir = join(ROOT, 'docs')
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir)) {
      if (f.endsWith('.md')) targets.push(join(docsDir, f))
    }
  }

  // 形如 `Version: 1.2.3` / `当前版本：1.2.3` / 裸的 1.2.3
  const versionish = /\b\d+\.\d+\.\d+\b/
  const offenders = []

  for (const p of targets) {
    if (!existsSync(p)) continue
    const lines = readFileSync(p, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      // 跳过引用块（`>`）：那里是**解释历史**的地方，允许提到旧版本号
      if (trimmed.startsWith('>')) return
      if (!versionish.test(line)) return
      // 允许"版本只有一个来源"这类指向 VERSION 的写法：不含数字就不触发
      offenders.push(`${p.replace(ROOT + '\\', '').replace(ROOT + '/', '')} 第 ${i + 1} 行: ${trimmed.slice(0, 90)}`)
    })
  }

  assert.deepEqual(
    offenders,
    [],
    '文档里出现了硬编码版本号 —— 版本只有一个来源（VERSION 文件），' +
      '文档应当指向它而不是复述：\n' +
      offenders.join('\n')
  )
})

// ---------------------------------------------------------------------------
// 语法自检
// ---------------------------------------------------------------------------

test('【防线】两个入口文件括号必须配平', () => {
  // 为什么要有这条：本轮开发中，我用 edit 做局部替换时**两次破坏了括号结构**
  // （一次吃掉 `)`，一次吃掉 `return h(`），而两次都得靠手动跑 node --check
  // 才发现。测试套件里缺这一层，等于把最容易犯的错留给运气。
  //
  // 这里做的是保守的括号配平（跳过注释与字符串）——
  // 它抓不住所有语法错误，但恰好能抓住"局部替换吃掉一个括号"这一类。
  // ⚠️ 已知局限：**它不认识正则字面量。**
  // 2026-10-05 我写了一个含引号与反引号的字符类正则（用来剔除标点），
  // 检查器把正则里的引号当成字符串起始，于是报"括号不配平" —— 假阳性。
  // 处理方式：不去改这个检查器（可靠识别正则很难），
  // 而是把那处正则改成不含引号/反引号的写法（只保留字母数字）。
  // 若将来又被它误报，先看是不是正则里带了引号或反引号。
  for (const rel of ['index.mjs', 'dsh/client.js']) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSDoc）
      .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1') // 行注释（避开 http://）

    let depth = 0
    let quote = null
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i]
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if (ch === '(' || ch === '{' || ch === '[') depth++
      else if (ch === ')' || ch === '}' || ch === ']') depth--
      if (depth < 0) {
        assert.fail(`${rel} 在第 ${i} 个字符附近括号提前闭合（多了一个右括号）`)
      }
    }
    assert.equal(depth, 0, `${rel} 括号不配平，余 ${depth} 个未闭合`)
  }
})

test('【防线】client.js 能被解析（new Function 只解析不执行）', () => {
  const src = readFileSync(join(ROOT, 'dsh', 'client.js'), 'utf8')
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(src)
  }, 'dsh/client.js 语法错误')
})

// ---------------------------------------------------------------------------
// 事故防线（二）：不监听任何事件
// ---------------------------------------------------------------------------

test('【事故2】apply 只注册工具 + 观察 pre-step，不监听其它事件', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)

  assert.deepEqual(
    ctx._tools.map((t) => t.name),
    ['constraints', 'cost'],
    '应注册 constraints 与 cost 两个工具'
  )

  // ⚠️ 从"完全不许监听"放宽到"只许监听 agent/pre-step"。
  //
  // 历史：pre-step 处理器曾用"原样透传 next() 结果"的写法，
  // 而 next() 返回 undefined 时透传 undefined → 宿主读 .kind 崩。
  // 现在的策略是**只观察**（把 decision 的真实形状写进探针），
  // 返回值仍然原样透传 —— 下面几条测试守着"不改返回值"这个不变量。
  assert.deepEqual(
    Object.keys(ctx._handlers),
    ['agent/pre-step'],
    `只允许监听 agent/pre-step，发现: ${Object.keys(ctx._handlers).join(', ')}`
  )
})

test('【事故2】pre-step 观察器必须原样返回 next() 的结果，绝不改写', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const handler = ctx._handlers['agent/pre-step']
  assert.equal(typeof handler, 'function', '应当注册 pre-step 观察器')

  // 宿主可能返回任何东西。**任何情况下都必须原样返回** ——
  // 一旦改写（把 undefined 换成别的东西，或反过来），就会篡改宿主的行为，
  // 这正是上一轮崩溃的形态。
  const cases = [
    undefined,
    null,
    {},
    { kind: 'reject' },
    { kind: 'enter', messages: [] },
  ]
  for (const value of cases) {
    const out = await handler({ agent: {} }, async () => value)
    assert.deepEqual(
      out,
      value,
      `${JSON.stringify(value)} 没有被原样返回（实际 ${JSON.stringify(out)}）`
    )
  }
})

test('【事故2】pre-step 的 next() 抛错时向上传播，不吞掉', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  await assert.rejects(
    () =>
      ctx._handlers['agent/pre-step']({ agent: {} }, async () => {
        throw new Error('下游失败')
      }),
    /下游失败/,
    '下游的错误必须向上传播，插件不该改写别人的失败'
  )
})

test('【事故2】源码只允许监听 agent/pre-step', async () => {
  const src = readFileSync(join(ROOT, 'index.mjs'), 'utf8')
  const calls = [...src.matchAll(/ctx\.on\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert.deepEqual(
    calls,
    ['agent/pre-step'],
    `只允许监听 agent/pre-step，发现: ${calls.join(', ')}`
  )
})

// ---------------------------------------------------------------------------
// 注册契约
// ---------------------------------------------------------------------------

test('工具的 parameters 是 JSON Schema，不是 defineTool 的 DSL', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const params = ctx._tools[0].parameters

  assert.equal(params.type, 'object')
  assert.ok(params.properties && params.properties.action, '应有 action 属性')
  assert.deepEqual(params.required, ['action'], 'required 必须是数组')
  // ⚠️ 这个清单**必须跟着工具同步改**。
  // 2026-10-05 加了 action=symptom（按症状查目录）——
  // 这条断言当时就红了，是"清单钉死"与"工具演进"之间的正常摩擦，
  // 不是回归。改工具的动作清单时要一起改这里（R-011：两处说同一件事）。
  assert.deepEqual(params.properties.action.enum, [
    'symptom',
    'show',
    'l0',
    'path',
    'where',
  ])
  assert.notEqual(params.properties.action.required, true, '不该是 defineTool 的 DSL 形状')
})

test('工具声明了 output.schema 与 render', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const tool = ctx._tools[0]
  assert.ok(tool.output && tool.output.schema, '必须有 output.schema')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
})

// ---------------------------------------------------------------------------
// 工作目录解析（第三个真实坑）
// ---------------------------------------------------------------------------

test('【坑】工具用 exec.agent 的会话 cwd 定位规则库，而不是 process.cwd()', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const tool = ctx._tools[0]

  const project = makeInstalledProject()
  const prevCwd = process.cwd()
  try {
    process.chdir(ROOT)
    const exec = { agent: { session: { header: { cwd: project } } } }
    const p = await tool.execute({ action: 'path' }, exec)
    assert.ok(p.startsWith(project), `应当用会话 cwd 定位规则库，实际返回: ${p}`)
  } finally {
    process.chdir(prevCwd)
    rmSync(project, { recursive: true, force: true })
  }
})

test('没有 agent 上下文时降级到 process.cwd()，不抛错', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)

  for (const exec of [undefined, null, {}, { agent: null }, { agent: {} }, { agent: { session: {} } }]) {
    const msg = await ctx._tools[0].execute({ action: 'where' }, exec)
    const diag = JSON.parse(msg)
    assert.equal(typeof diag.cwd使用值, 'string')
    assert.ok(diag.cwd使用值.length > 0, '必须始终有一个可用的 cwd')
  }
})

// ---------------------------------------------------------------------------
// 工具行为
// ---------------------------------------------------------------------------

test('工具能定位规则库并解析 L0 铁律', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const tool = ctx._tools[0]

  const project = makeInstalledProject()
  const prevCwd = process.cwd()
  process.chdir(project)
  try {
    const l0 = await tool.execute({ action: 'l0' })
    assert.match(l0, /R-001 凭据绝不硬编码/)
    assert.match(l0, /R-002/)
    assert.doesNotMatch(l0, /C-001/, 'L1 条目混进了 L0 输出')

    const all = await tool.execute({ action: 'show' })
    assert.match(all, /测试规则库/)
  } finally {
    process.chdir(prevCwd)
    rmSync(project, { recursive: true, force: true })
  }
})

test('未安装指令包时给出可操作的提示，而不是抛错', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)

  const empty = mkdtempSync(join(process.env.TEMP || '/tmp', 'adc-empty-'))
  const prevCwd = process.cwd()
  process.chdir(empty)
  try {
    const msg = await ctx._tools[0].execute({ action: 'show' })
    assert.match(msg, /没有安装 agent-constraints/)
    assert.match(msg, /npx agent-development-constraints install/)
  } finally {
    process.chdir(prevCwd)
    rmSync(empty, { recursive: true, force: true })
  }
})

test('未知 action 抛错（走 dsh 工具管道的错误路径）', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  await assert.rejects(() => ctx._tools[0].execute({ action: 'nope' }), /unknown action/)
})

test('execute 收到畸形 args 时不崩（action 缺失/类型错误）', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const tool = ctx._tools[0]

  // action 缺失或类型不对时走 default 分支抛错，但不该是 TypeError
  for (const args of [{}, { action: 123 }, { action: null }, null, undefined]) {
    await assert.rejects(
      () => tool.execute(args, undefined),
      (err) => err instanceof Error && /unknown action/.test(err.message),
      `畸形 args ${JSON.stringify(args)} 应当走 unknown action，而不是别的异常`
    )
  }
})

// ---------------------------------------------------------------------------
// 「绝不崩」防线
// ---------------------------------------------------------------------------

test('【事故防线】apply 在畸形 ctx 下不抛错，只降级', async () => {
  const plugin = await load()
  const badCtxList = [
    {},
    { tools: null },
    { tools: {} },
    { tools: { register: () => { throw new Error('注册失败') } } },
    { on: () => { throw new Error('监听失败') } },
  ]
  for (const [i, ctx] of badCtxList.entries()) {
    assert.doesNotThrow(
      () => plugin.apply(ctx),
      `第 ${i} 个畸形 ctx 让 apply 抛错了 —— 这正是第一次崩溃的形态`
    )
  }
})


// ---------------------------------------------------------------------------
// 按症状查目录（用户的原始诉求：「我有一本书 我看到了目录 快速找到问题」）
//
// ⚠️ 这一组测试**故意用"换个说法"去查**，而不是照抄表里的原文。
// 第一版实现按词切分 + 子串匹配，实测大量漏命中：
//   q="没反应也不报错"  → 无命中（表里是「没反应、也不报错」，差一个顿号）
//   q="扫描报0"        → 无命中（表里是「扫描报告"0 处问题"，但实际有」）
// 所以这里把"换个说法也要命中"固化成断言 —— 索引不能用原话才能查。
// ---------------------------------------------------------------------------

/** 造一个装了**真实规则库**的项目（拿仓库自己的 core/constraints.md 复制过去） */
function makeProjectWithRealLibrary() {
  const dir = mkdtempSync(join(process.env.TEMP || '/tmp', 'adc-real-'))
  const coreDir = join(dir, 'agent-constraints', 'core')
  mkdirSync(coreDir, { recursive: true })
  const real = readFileSync(join(ROOT, 'core', 'constraints.md'), 'utf8')
  writeFileSync(join(coreDir, 'constraints.md'), real, 'utf8')
  return dir
}

test('【目录】action=symptom 不带 q 时返回完整目录（分类可见）', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const project = makeProjectWithRealLibrary()
  const prevCwd = process.cwd()
  process.chdir(project)
  try {
    const out = await ctx._tools[0].execute({ action: 'symptom' })
    assert.match(out, /目录/, '应说明这是目录')
    for (const cat of ['测试', '接口 / 数据 / 安全', '界面 / 交互']) {
      assert.ok(out.includes(cat), `目录里应能看到分类「${cat}」`)
    }
    // 目录要有编号，否则只能看不能跳
    assert.match(out, /R-\d+/, '目录条目应带规则编号')
  } finally {
    process.chdir(prevCwd)
    rmSync(project, { recursive: true, force: true })
  }
})

test('【目录】换个说法也要能查到（索引的可用性）', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const project = makeProjectWithRealLibrary()
  const prevCwd = process.cwd()
  process.chdir(project)
  try {
    // ⚠️ 左边是"用户会怎么描述"，不是表里的原文
    const cases = [
      ['整套测试慢', 'R-013'],
      ['没反应也不报错', 'R-015'],
      ['扫描报0', 'R-014'],
      ['未登录返回email', 'R-007'],
      ['版本号对不上', 'R-011'],
    ]
    for (const [q, expectId] of cases) {
      const out = await ctx._tools[0].execute({ action: 'symptom', q })
      assert.ok(
        out.includes(expectId),
        `q=${JSON.stringify(q)} 应命中 ${expectId}，实际输出：\n${out.slice(0, 300)}`
      )
    }
  } finally {
    process.chdir(prevCwd)
    rmSync(project, { recursive: true, force: true })
  }
})

test('【目录】命中后要给出规则**全文**，而不是只给编号', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const project = makeProjectWithRealLibrary()
  const prevCwd = process.cwd()
  process.chdir(project)
  try {
    const out = await ctx._tools[0].execute({ action: 'symptom', q: '整套测试慢' })
    // 编号不够 —— 用户要的是"快速找到问题"，得能看到规则本身
    assert.match(out, /R-013/, '应命中 R-013')
    assert.match(out, /\*\*规则\*\*/, '应带出规则全文的四要素（含「规则」）')
    assert.match(out, /触发|检查/, '应带出规则的触发/检查要素')
  } finally {
    process.chdir(prevCwd)
    rmSync(project, { recursive: true, force: true })
  }
})

test('【目录】查不到时给可用分类，不抛错', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const project = makeProjectWithRealLibrary()
  const prevCwd = process.cwd()
  process.chdir(project)
  try {
    const out = await ctx._tools[0].execute({
      action: 'symptom',
      q: '完全不存在的症状zzzqqq',
    })
    assert.match(out, /没有匹配|目录/, '应给出可操作的提示')
    assert.ok(!/unknown action/.test(out), '不该走 unknown action 分支')
  } finally {
    process.chdir(prevCwd)
    rmSync(project, { recursive: true, force: true })
  }
})

test('【注入】注入的是**目录**，且体积受控（每会话一次，进历史后每轮重发）', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const project = makeProjectWithRealLibrary()
  const prevCwd = process.cwd()
  process.chdir(project)
  try {
    const agent = {}
    const tpl = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }
    const decision = { kind: 'enter', messages: [tpl] }
    const out = await ctx._handlers['agent/pre-step'](
      { agent },
      async () => decision
    )
    assert.equal(out.messages.length, 2, '应追加一条注入消息')
    const injected = out.messages[1]
    const text = injected.content[0].text
    assert.match(text, /目录/, '注入的应是目录')
    assert.match(text, /symptom/, '应告诉 AI 怎么按症状查')
    assert.ok(
      text.length < 400,
      `注入体积过大：${text.length} 字符（每会话一次，会进历史并被每轮重发）`
    )
    // 每个 agent 只注入一次
    const again = await ctx._handlers['agent/pre-step'](
      { agent },
      async () => decision
    )
    assert.equal(again.messages.length, 1, '同一个 agent 不该被注入第二次')
  } finally {
    process.chdir(prevCwd)
    rmSync(project, { recursive: true, force: true })
  }
})
