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
