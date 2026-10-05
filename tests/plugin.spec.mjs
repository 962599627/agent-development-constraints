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
import { mkdirSync, writeFileSync, rmSync, readFileSync, mkdtempSync } from 'node:fs'
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
  assert.deepEqual(params.properties.action.enum, ['show', 'l0', 'path', 'where'])
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
