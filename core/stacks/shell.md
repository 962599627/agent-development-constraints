# Shell / PowerShell / bash

> 这一节踩坑密度最高 —— 脚本的错误往往**看起来像别的问题**（编码、转义、退出码）。

## PowerShell

### PowerShell · .ps1 文件缺 UTF-8 BOM → 中文乱码、脚本解析失败
- **症状**：脚本报 `表达式或语句中包含意外的标记`、中文变成 `鏅鸿兘浣撳紑鍙戝害鏉熷寘`，
  而且**报错位置看起来莫名其妙**（指向一个语法完全正常的行）
- **原因**：**Windows PowerShell 5.1 读取 `.ps1` 时若无 BOM，会按 ANSI(GBK) 解码** →
  中文字符串被截断成乱码字节 → 语法结构被破坏
- **修法**：把脚本存成 **UTF-8 with BOM**：
  ```powershell
  $c = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
  [System.IO.File]::WriteAllText($p, $c, (New-Object System.Text.UTF8Encoding $true))
  ```
  （`$true` = 带 BOM）
- **来源**：agent-constraints（2026-04，安装脚本首次运行直接解析失败）

### PowerShell · 双引号字符串里反引号是转义符
- **症状**：字符串**少了字符**（尤其开头的字母被吞掉），
  例如 `agent-constraints` 变成 `gent-constraints`
- **原因**：双引号字符串中 `` ` `` 是转义引导符，`` `a `` 被解析成 **BEL 控制字符**（不可见），
  于是 `a` 消失了
- **修法**：路径等含反引号的内容用**单引号**字符串（不解析转义）；
  或把反引号写成 `` `` ``（两个）
- **来源**：agent-constraints（2026-04，注入的路径少了开头的 `a`）

### PowerShell · 退出码误报（命令实际成功却返回 1）
- **症状**：脚本里 `git push` / `npm` 等**明明成功了**，`$LASTEXITCODE` 却是 1，
  输出里出现 `git : ...` 这样的红字"错误"
- **原因**：外部程序把**进度/提示写 stderr**，PowerShell 把 stderr 一律当错误记录，
  并令 `$LASTEXITCODE` 变成 1
- **修法**：**看 stdout 里的真实结果**（如 `0df40a8..5753983  main -> main`）判断成败，
  不要只信退出码；需要静默就 `2>$null` 或 `2>&1 | Out-String`
- **来源**：agent-constraints（2026-04，推送成功但报 exit code 1）

### PowerShell · 检索/探测类命令本身要等很久
- **症状**：命令长时间无输出，看起来像卡死
- **原因**：`Test-NetConnection` 默认要等 20 秒以上；重试循环 × sleep 会累积到数分钟
- **修法**：探测用 `curl --max-time 5`；重试和耗时任务**丢到后台**执行并主动告知，
  不要让调用方干等
- **来源**：agent-constraints（2026-04）→ 已升级为 **C-005 / C-006**

### PowerShell · 变量名与自动变量冲突
- **症状**：赋值后取值不对，或直接报只读变量错误
- **原因**：`$home` / `$pid` / `$host` 等是 PowerShell 自动变量，**大小写不敏感**
- **修法**：用中性名字（`$procId`、`$targetDir`）
- **来源**：二次元博客（2026-04）

---

## bash

### bash · CRLF 行尾导致脚本无法执行
- **症状**：`bad interpreter: No such file or directory`，
  或者报 `$'\r': command not found`
- **原因**：脚本在 Windows 上编辑过，行尾是 CRLF，而 bash 只认 LF
- **修法**：转成 LF：
  ```bash
  sed -i 's/\r$//' script.sh
  ```
  或在编辑器里把换行符设为 LF
- **来源**：agent-constraints（2026-04，写 install.sh 时主动检查）

### bash · grep 无匹配时的退出码让 `set -e` 挂掉
- **症状**：脚本在某个 `grep` 处**莫名退出**，没有报错信息
- **原因**：`set -e` 下，`grep` 无匹配返回 1 → 脚本立即退出
- **修法**：预期可能无匹配的地方加 `|| true`，或用 `grep -c` 配合判断
- **来源**：通用经验（在 install.sh 中主动规避）

### bash · awk 的 gawk 扩展不跨平台
- **症状**：脚本在 Linux 正常，在 macOS 报 awk 语法错误
- **原因**：`match($0, /re/, arr)` 三参数形式是 **gawk 扩展**，BSD awk 不支持
- **修法**：用 POSIX 写法（`$0 ~ /re/` + `substr`），或检测并降级
- **来源**：agent-constraints（2026-04，contribute.sh 中使用了该扩展）

---

## 通用（跨 shell）

### Shell · 静默失败
- **症状**：脚本"成功"结束，但该做的事没做
- **原因**：命令失败被 `| Out-Null` / `2>/dev/null` / `-ErrorAction SilentlyContinue` 吞掉
- **修法**：关键步骤**检查结果而不是检查是否报错**；必要时打印命令的真实输出
- **来源**：通用经验
