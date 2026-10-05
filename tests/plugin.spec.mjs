/**
 * 插件契约测试
 *
 * ## 这个文件的存在理由（一次真实事故）
 *
 * 第一版插件在真实 DSH 里**让宿主会话崩了**，报
 * `Cannot read properties of undefined (reading 'kind')`。两个根因：
 *
 *  1. 顶层 `import { defineTool } from '@deepseek-ai/dsh-tools'`，而 profile 设了
 *     `autoInstallPeers: false` —— peer 依赖不会被安装，模块解析失败，
 *     加载器处理那行时拿到 undefined 就炸。
 *  2. `parameters` 用了 `defineTool` 的 DSL 格式，而手写的 `parameters`
 *     必须是 JSON Schema。
 *
 * 当时的测试之所以没挡住，是因为它**自己造了 stub** 让 import 成功 ——
 * 于是测的是"我假想的环境"，而不是真实环境。
 *
 * 所以现在：
 *  - **不建任何 stub**：插件必须零外部依赖就能加载（这正是第一条回归防线）
 *  - 加了大量**畸形输入**用例：无论宿主传什么，插件都不许抛错
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
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

/** 造一个假的 ctx，收集注册与监听的调用 */
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
// 第一条回归防线：零外部依赖
// ---------------------------------------------------------------------------

test('【事故防线】插件不依赖任何外部包，无需 stub 即可加载', async () => {
  // 这条曾经失败：插件顶层 import 了 @deepseek-ai/dsh-tools，
  // 而那个包在 profile 里根本不会被安装。
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'index.mjs'), 'utf8')
  const external = [...src.matchAll(/^import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith('node:'))
  assert.deepEqual(
    external,
    [],
    `插件只能 import node: 内置模块，发现外部依赖: ${external.join(', ')}`
  )

  // 而且必须真的能加载（上面只是静态检查）
  const plugin = await load()
  assert.equal(plugin.name, 'agent-development-constraints')
  assert.equal(typeof plugin.apply, 'function')
})

test('package.json 不声明会阻止安装的 peerDependencies', async () => {
  const pkg = JSON.parse(
    (await import('node:fs')).readFileSync(join(ROOT, 'package.json'), 'utf8')
  )
  // profile 的 pnpm-workspace.yaml 设了 autoInstallPeers: false，
  // 声明 peerDep 等于声明一个永远装不上的依赖。
  assert.equal(pkg.peerDependencies, undefined, '不该声明 peerDependencies')
  assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, '必须声明 dsh.bundle')
})

// ---------------------------------------------------------------------------
// 注册契约
// ---------------------------------------------------------------------------

test('apply 注册 constraints 工具并监听 agent/pre-step', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)

  assert.equal(ctx._tools.length, 1, '应注册且只注册一个工具')
  assert.equal(ctx._tools[0].name, 'constraints')
  assert.deepEqual(Object.keys(ctx._handlers), ['agent/pre-step'])
})

test('工具的 parameters 是 JSON Schema，不是 defineTool 的 DSL', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const params = ctx._tools[0].parameters

  // 第二条事故防线：手写 ToolDefinition 必须给 JSON Schema 形状。
  assert.equal(params.type, 'object')
  assert.ok(params.properties && params.properties.action, '应有 action 属性')
  assert.deepEqual(params.required, ['action'], 'required 必须是数组')
  assert.deepEqual(params.properties.action.enum, ['show', 'l0', 'path', 'where'])
  // DSL 会写成 properties.action.required === true，那是错的
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
    // 把 process.cwd() 指向没有规则库的地方，只让会话 cwd 指向有规则库的项目。
    // 若实现退回 process.cwd()，这条会失败。
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

// ---------------------------------------------------------------------------
// 「绝不崩」防线 —— 宿主传什么都不能让会话失败
// ---------------------------------------------------------------------------

test('【事故防线】apply 在畸形 ctx 下不抛错，只降级', async () => {
  const plugin = await load()
  // 各种"宿主还没准备好"的情形
  const badCtxList = [
    {},
    { tools: null },
    { tools: {} }, // 没有 register
    { tools: { register: () => { throw new Error('注册失败') } } },
    { on: () => { throw new Error('监听失败') } },
  ]
  for (const [i, ctx] of badCtxList.entries()) {
    assert.doesNotThrow(
      () => plugin.apply(ctx),
      `第 ${i} 个畸形 ctx 让 apply 抛错了 —— 这正是上次崩溃的形态`
    )
  }
})

test('【事故防线】pre-step 在畸形 next 返回值下原样透传，不抛错', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const handler = ctx._handlers['agent/pre-step']

  // 宿主可能返回任何东西；返回 undefined 正是上次崩溃的触发条件
  const weirdReturns = [undefined, null, {}, { kind: 'reject' }, { kind: 'enter' }, { kind: 'enter', messages: null }]
  for (const [i, value] of weirdReturns.entries()) {
    const out = await handler({ agent: {} }, async () => value)
    assert.deepEqual(
      out,
      value,
      `第 ${i} 个返回值（${JSON.stringify(value)}）没有被原样透传 —— 改动宿主的决定会导致会话失败`
    )
  }
})

test('【事故防线】pre-step 的 next() 抛错时向上传播，不吞掉', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const handler = ctx._handlers['agent/pre-step']

  await assert.rejects(
    () => handler({ agent: {} }, async () => { throw new Error('下游失败') }),
    /下游失败/,
    '下游的错误必须向上传播，插件不该改写别人的失败'
  )
})

test('pre-step 返回合法的 PreStepDecision，人类输入留在最前', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const handler = ctx._handlers['agent/pre-step']

  const project = makeInstalledProject()
  try {
    const original = [{ role: 'user', content: [{ type: 'text', text: '人类输入' }] }]
    const decision = await handler(
      { agent: { session: { header: { cwd: project } } } },
      async () => ({ kind: 'enter', messages: original })
    )

    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages[0], original[0], '人类输入不能被挤走')
    assert.equal(decision.messages.length, 2, '应当追加一条注入')

    const injected = decision.messages[1]
    assert.equal(injected.role, 'user', 'UserMessage 必须带 role: "user"')
    assert.ok(Array.isArray(injected.content), 'UserMessage 必须带 content 数组')
    assert.match(injected.content[0].text, /开发约束 · 来自 agent-constraints/)
    assert.match(injected.content[0].text, /R-001/, '注入的应是 L0 铁律标题')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('reject 决定原样透传，且不注入', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)
  const rejected = { kind: 'reject' }
  const out = await ctx._handlers['agent/pre-step']({ agent: {} }, async () => rejected)
  assert.deepEqual(out, rejected, 'reject 必须原样返回，不能改成 enter')
})

test('没有规则库时不注入（保留原批次）', async () => {
  const plugin = await load()
  const ctx = makeCtx()
  plugin.apply(ctx)

  const empty = mkdtempSync(join(process.env.TEMP || '/tmp', 'adc-nolib-'))
  try {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]
    const decision = await ctx._handlers['agent/pre-step'](
      { agent: { session: { header: { cwd: empty } } } },
      async () => ({ kind: 'enter', messages: msgs })
    )
    assert.equal(decision.messages.length, 1, '找不到规则库时不该多塞消息')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
