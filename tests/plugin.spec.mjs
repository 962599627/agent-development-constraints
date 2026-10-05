/**
 * 插件契约测试
 *
 * 为什么要 stub：插件通过 peerDependency 引用 harness 提供的
 * `@deepseek-ai/dsh-tools`，独立 checkout 里没有它，直接 import 会失败。
 * 本测试先放一个最小 stub，再真实加载插件 —— 这样测的是**真实代码路径**，
 * 而不是把逻辑复制一份到测试里（那样测的只是复制的副本）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STUB_DIR = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools')

let plugin
let tempProject

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

before(() => {
  // 放一个最小 stub，让 import 能解析到
  mkdirSync(STUB_DIR, { recursive: true })
  writeFileSync(
    join(STUB_DIR, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js' })
  )
  writeFileSync(join(STUB_DIR, 'index.js'), 'export function defineTool(def) { return def }\n')
})

after(() => {
  // 只删我们造的 stub 目录，不动别人的 node_modules
  try { rmSync(join(ROOT, 'node_modules'), { recursive: true, force: true }) } catch {}
  if (tempProject && existsSync(tempProject)) rmSync(tempProject, { recursive: true, force: true })
})

// ---------- 导出契约 ----------

test('导出 DSH 插件需要的三个成员', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  assert.equal(plugin.name, 'agent-development-constraints')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
})

// ---------- apply 的注册行为 ----------

test('apply 注册 constraints 工具并监听 agent/pre-step', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const tools = []
  const events = []
  plugin.apply({
    tools: { register: (t) => tools.push(t) },
    on: (e) => events.push(e),
  })

  assert.equal(tools.length, 1, '应注册且只注册一个工具')
  assert.equal(tools[0].name, 'constraints')
  assert.deepEqual(events, ['agent/pre-step'], '应监听 agent/pre-step')
})

// ---------- 工具行为 ----------

test('工具能定位规则库并解析 L0 铁律', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const tools = []
  plugin.apply({ tools: { register: (t) => tools.push(t) }, on: () => {} })
  const tool = tools[0]

  tempProject = makeInstalledProject()
  const prev = process.cwd()
  process.chdir(tempProject)
  try {
    const p = await tool.execute({ action: 'path' })
    assert.ok(p.endsWith(join('agent-constraints', 'core', 'constraints.md')), `路径不对: ${p}`)

    const l0 = await tool.execute({ action: 'l0' })
    assert.match(l0, /R-001 凭据绝不硬编码/)
    assert.match(l0, /R-002/)
    // L1 的条目不能被当成铁律
    assert.doesNotMatch(l0, /C-001/, 'L1 条目混进了 L0 输出')

    const all = await tool.execute({ action: 'show' })
    assert.match(all, /测试规则库/)
  } finally {
    process.chdir(prev)
  }
})

test('未安装指令包时给出可操作的提示，而不是抛错', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const tools = []
  plugin.apply({ tools: { register: (t) => tools.push(t) }, on: () => {} })
  const tool = tools[0]

  const empty = mkdtempSync(join(process.env.TEMP || '/tmp', 'adc-empty-'))
  const prev = process.cwd()
  process.chdir(empty)
  try {
    const msg = await tool.execute({ action: 'show' })
    assert.match(msg, /没有安装 agent-constraints/)
    assert.match(msg, /npx agent-development-constraints install/)
  } finally {
    process.chdir(prev)
    rmSync(empty, { recursive: true, force: true })
  }
})

test('未知 action 抛错（走 dsh 工具管道的错误路径）', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const tools = []
  plugin.apply({ tools: { register: (t) => tools.push(t) }, on: () => {} })
  await assert.rejects(() => tools[0].execute({ action: 'nope' }), /unknown action/)
})

// ---------- 契约回归：两个在真实 DSH 里踩到的坑 ----------

test('【坑1】工具用 exec.agent 的会话 cwd 定位规则库，而不是 process.cwd()', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const tools = []
  plugin.apply({ tools: { register: (t) => tools.push(t) }, on: () => {} })
  const tool = tools[0]

  const project = makeInstalledProject()
  try {
    // 关键：把 process.cwd() 指向一个**没有**规则库的地方，
    // 只让 agent.session.header.cwd 指向有规则库的项目。
    // 如果实现退回 process.cwd()，这条就会失败。
    const prevCwd = process.cwd()
    process.chdir(ROOT) // F:\agent-constraints 本身没有 agent-constraints/ 子目录
    try {
      const fakeAgent = { session: { header: { cwd: project } } }
      const p = await tool.execute({ action: 'path' }, { agent: fakeAgent })
      assert.ok(
        p.startsWith(project),
        `应当用会话 cwd 定位规则库，实际返回: ${p}`
      )
    } finally {
      process.chdir(prevCwd)
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('【坑1】没有 agent 上下文时降级到 process.cwd()，不抛错', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const tools = []
  plugin.apply({ tools: { register: (t) => tools.push(t) }, on: () => {} })

  // exec 缺失 / agent 缺失 / session 缺失 —— 都不该崩
  for (const exec of [undefined, {}, { agent: {} }, { agent: { session: {} } }]) {
    const msg = await tools[0].execute({ action: 'where' }, exec)
    const diag = JSON.parse(msg)
    assert.equal(typeof diag.cwd使用值, 'string')
    assert.ok(diag.cwd使用值.length > 0, '必须始终有一个可用的 cwd')
  }
})

test('where 动作返回解析诊断（排障用）', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const tools = []
  plugin.apply({ tools: { register: (t) => tools.push(t) }, on: () => {} })

  const project = makeInstalledProject()
  try {
    const msg = await tools[0].execute(
      { action: 'where' },
      { agent: { session: { header: { cwd: project } } } }
    )
    const diag = JSON.parse(msg)
    assert.equal(diag.agent可用, true)
    assert.equal(diag.session可用, true)
    assert.ok(String(diag.规则库).startsWith(project), '诊断里应给出找到的规则库路径')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('【坑2】agent/pre-step 返回合法的 PreStepDecision，消息并入末尾', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const handlers = {}
  plugin.apply({
    tools: { register: () => {} },
    on: (evt, handler) => { handlers[evt] = handler },
  })
  const handler = handlers['agent/pre-step']
  assert.equal(typeof handler, 'function', '应当监听 agent/pre-step')

  const project = makeInstalledProject()
  try {
    const payload = {
      agent: { session: { header: { cwd: project } } },
      messages: [{ role: 'user', content: [{ type: 'text', text: '人类输入' }] }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    const original = { kind: 'enter', messages: payload.messages }
    const decision = await handler(payload, async () => original)

    // 必须仍是合法的 PreStepDecision
    assert.equal(decision.kind, 'enter')
    assert.ok(Array.isArray(decision.messages))
    // 人类输入必须还在最前（我们的提示只能追加在后面）
    assert.equal(decision.messages[0], payload.messages[0], '人类输入不能被挤走')
    // 必须多出一条注入
    assert.equal(decision.messages.length, 2)
    const injected = decision.messages[1]
    assert.equal(injected.role, 'user', 'UserMessage 必须带 role: "user"')
    assert.ok(Array.isArray(injected.content), 'UserMessage 必须带 content 数组')
    assert.match(injected.content[0].text, /开发约束 · 来自 agent-constraints/)
    assert.match(injected.content[0].text, /R-001/, '注入的应是 L0 铁律标题')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('【坑2】reject 决定原样透传，且不注入', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const handlers = {}
  plugin.apply({
    tools: { register: () => {} },
    on: (evt, handler) => { handlers[evt] = handler },
  })

  const rejected = { kind: 'reject' }
  const decision = await handlers['agent/pre-step']({ agent: {} }, async () => rejected)
  assert.deepEqual(decision, rejected, 'reject 必须原样返回，不能改成 enter')
})

test('【坑2】没有规则库时不注入（保留原批次）', async () => {
  plugin = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  const handlers = {}
  plugin.apply({
    tools: { register: () => {} },
    on: (evt, handler) => { handlers[evt] = handler },
  })

  const empty = mkdtempSync(join(process.env.TEMP || '/tmp', 'adc-nolib-'))
  try {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]
    const decision = await handlers['agent/pre-step'](
      { agent: { session: { header: { cwd: empty } } } },
      async () => ({ kind: 'enter', messages: msgs })
    )
    assert.equal(decision.messages.length, 1, '找不到规则库时不该多塞消息')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
