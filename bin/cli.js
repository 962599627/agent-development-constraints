#!/usr/bin/env node
'use strict';

/**
 * 智能体开发约束包 · CLI
 *
 * 设计原则：**只做转交，不重新实现逻辑** ——
 * 否则 npx 版和 git clone 版的行为会慢慢分叉。
 *
 * 唯一例外是 hooks：安装脚本以"自身所在位置"找仓库根，
 * 在 npx 场景下那是 npm 缓存目录，所以必须在**目标项目**里自己实现。
 *
 * 用法：
 *   npx github:962599627/agent-development-constraints install [目标目录]
 *   npx github:962599627/agent-development-constraints check   [目标目录]
 *   npx github:962599627/agent-development-constraints contribute [目标目录]
 *   npx github:962599627/agent-development-constraints hooks   [目标目录]
 *   npx github:962599627/agent-development-constraints version
 *
 * ⚠️ 必须带 `github:` 前缀 —— 本包**未发布到 npm**，
 *    短形式 `npx agent-development-constraints ...` 会 404。
 *    这里的用法串与 README 保持一致（两处说同一件事），改动时一起改。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const cmd = (argv[0] || 'help').toLowerCase();
const target = path.resolve(argv[1] || process.cwd());

// ---------- 工具 ----------

function version() {
  try {
    return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  } catch (e) {
    return require(path.join(ROOT, 'package.json')).version;
  }
}

function which(bin) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(finder, [bin], { stdio: 'ignore' }).status === 0;
}

const log = (msg) => process.stdout.write(msg + '\n');

// 执行包内的脚本。
// stdio 用 'inherit'：让子进程直接继承终端 —— 沙箱下管道会带来平台差异。
// cwd 传目标项目：脚本里的 git ls-files 等操作要作用在**用户的仓库**上。
function runScript(kind, scriptArgs, cwd) {
  // ⚠️ 脚本位置不统一，实测踩过：
  //    install / contribute 在**包根目录**，其余工具在 scripts/ 下。
  //    统一放在一个目录会更整洁，但为了不破坏已有的调用方式（文档、hook 都引用了原路径），
  //    这里显式区分。
  const inRoot = kind === 'install' || kind === 'contribute';
  const base = inRoot ? ROOT : path.join(ROOT, 'scripts');
  const ps1 = path.join(base, kind + '.ps1');
  const sh = path.join(base, kind + '.sh');
  const opts = { stdio: 'inherit', cwd: cwd || target };

  if (process.platform === 'win32') {
    const shell = which('pwsh') ? 'pwsh' : (which('powershell') ? 'powershell' : null);
    if (!shell) {
      log('找不到 PowerShell，无法执行 ' + kind);
      return 1;
    }
    if (!fs.existsSync(ps1)) {
      log('找不到 ' + ps1);
      return 1;
    }
    return spawnSync(shell, ['-NoProfile', '-File', ps1, ...scriptArgs], opts).status || 0;
  }

  if (!fs.existsSync(sh)) {
    log('找不到 ' + sh);
    return 1;
  }
  return spawnSync('sh', [sh, ...scriptArgs], opts).status || 0;
}

// ---------- hooks：必须在目标项目里做 ----------

function installHooks() {
  const gitDir = path.join(target, '.git');
  if (!fs.existsSync(gitDir)) {
    log(`错误：${target} 不是 git 仓库`);
    return 1;
  }

  const src = path.join(ROOT, '.githooks');
  if (!fs.existsSync(src)) {
    log('错误：包内找不到 .githooks/');
    return 1;
  }

  const dst = path.join(target, '.githooks');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }

  // ------------------------------------------------------------------
  // ⚠️ 还必须把**检查脚本与黑名单**一起装上。
  //
  // 实测踩到的假安装（2026-10-05，在 python2 博客项目上）：
  //   `hooks` 只装了 .githooks/pre-commit 并设了 core.hooksPath，
  //   而 pre-commit 找不到 sanitize-check.ps1 时会打印
  //   「⚠️ 找不到脱敏检查脚本，跳过」然后 **exit 0** ——
  //   于是每次提交都"看起来检查了"，实际什么都没查：
  //   自动化装了等于没装。
  //
  // 检查脚本要读 <root>/.sanitize-deny.txt（$root = 脚本所在目录的上级），
  // 所以脚本放 <target>/scripts/、黑名单放 <target>/ 下，两者配套。
  //
  // 已存在的一律**不覆盖** —— 用户可能已经按自己项目改过黑名单。
  // ------------------------------------------------------------------
  const scriptsDir = path.join(target, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const wanted = [
    ['.sanitize-deny.txt', path.join(target, '.sanitize-deny.txt')],
    ['scripts/sanitize-check.ps1', path.join(scriptsDir, 'sanitize-check.ps1')],
    ['scripts/sanitize-check.sh', path.join(scriptsDir, 'sanitize-check.sh')],
  ];
  const installed = [];
  const skipped = [];
  for (const [rel, dest] of wanted) {
    const from = path.join(ROOT, rel.split('/').join(path.sep));
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(dest)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
    installed.push(rel);
  }
  if (installed.length === 0 && skipped.length === 0) {
    log('错误：包内找不到脱敏检查脚本（sanitize-check.ps1 / .sh）');
    return 1;
  }

  const r = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: target,
    stdio: 'inherit',
  });
  if ((r.status || 0) !== 0) {
    log('设置 core.hooksPath 失败');
    return 1;
  }

  log('');
  log('✓ git hooks 已启用（core.hooksPath = .githooks）');
  if (installed.length) log(`✓ 脱敏检查已装：${installed.join('、')}`);
  if (skipped.length) log(`· 已存在、未覆盖（保留你的改动）：${skipped.join('、')}`);
  log('');
  log('  现在每次 git commit 都会先跑脱敏检查，不通过会拒绝提交。');
  log('  绕过：git commit --no-verify（请说明理由）');
  log('');
  return 0;
}

// ---------- help ----------

function help() {
  log(`
智能体开发约束包 v${version()}

用法：
  agent-constraints install [目录]      安装到项目（幂等，不覆盖你已积累的规则）
  agent-constraints check   [目录]      脱敏检查（安全网，可选）
  agent-constraints contribute [目录]   提取你新增的规则，生成可提交的贡献包
  agent-constraints hooks   [目录]      启用 git hooks（每次提交自动脱敏检查）
  agent-constraints version             显示版本
  agent-constraints help                显示本帮助

不传目录时默认当前目录。

它是什么：
  一个**会学习的学生** —— 从每次踩坑里学到一点，越用越懂。
  核心是四层规则库 + 提炼 / 合并 / 精简三套流程。
  脱敏检查只是**可选的安全网**：删掉 scripts/ .githooks/ .sanitize-deny.txt
  也不影响正常使用。

隐私：零网络、只读仓库内文件、不自动提交。详见 PRIVACY.md
`);
}

// ---------- 分发 ----------

function main() {
  switch (cmd) {
    case 'install':
    case 'i':
      return runScript('install', [target]);

    case 'check':
      // 不带额外参数：默认检查目标项目里全部已跟踪文件
      return runScript('sanitize-check', []);

    case 'contribute':
      return runScript('contribute', [target]);

    case 'hooks':
      return installHooks();

    case 'version':
    case '-v':
    case '--version':
      log(version());
      return 0;

    case 'help':
    case '-h':
    case '--help':
      help();
      return 0;

    default:
      log(`未知命令：${cmd}\n`);
      help();
      return 1;
  }
}

process.exit(main());
