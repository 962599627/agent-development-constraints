# git / 版本控制

## 传输

### git · push/fetch 报连接超时，但 curl 明明能通
- **症状**：`fatal: unable to access '...': Failed to connect to github.com port 443 after 21051 ms`
  —— 但同一时刻 `curl https://github.com` 返回 **200**
- **原因**：不是网络断了，是 **git 在 HTTP/2 上挂起**（curl 默认走 HTTP/1.1 所以正常）
- **修法**：
  ```powershell
  git config http.version HTTP/1.1
  # 可选：防止大传输被截断 / 低速被主动断开
  git config http.postBuffer 524288000
  git config http.lowSpeedLimit 0
  git config http.lowSpeedTime 999999
  ```
  实测改完**立刻推送成功**
- **来源**：agent-constraints（2026-04，连续两次推送失败后诊断出来）→ 已记入 **C-006**

### git · 凭据认证失败 vs 传输失败要分清
- **症状**：`Authentication failed` / `could not read Username` / `Permission denied`
- **原因**：凭据问题（token 过期、未配置），**与网络无关**
- **修法**：先确认是**认证层**还是**传输层**：
  - 认证失败 → 检查凭据管理器 / token
  - 连接超时 → 见上一条
  设置 `GIT_TERMINAL_PROMPT=0` 可以让它在无凭据时**立即失败**而不是挂住等输入
- **来源**：agent-constraints（2026-04）

---

## 提交与历史

### git · `.gitignore` 防不住已经写进文件里的值
- **症状**：明明忽略了 `.env`，密码**还是**进了仓库
- **原因**：`.gitignore` 只影响**未被跟踪的文件**；密码本来就在 `settings.py` 等**已跟踪**的源码里
- **修法**：判断是否安全要看**内容**，不是看文件名。用
  `git grep -n -I -E '<敏感值>' HEAD` **直接在当前提交内容里搜**
- **来源**：某博客项目（2026-04，三处明文密码）→ 已升级为 **R-002**

### git · 敏感信息进了历史，改文件没用
- **症状**：以为删掉那行密码就安全了，其实 `git log -p` 仍能翻出来
- **原因**：git 保留完整历史；**提交即留痕**
- **修法**：
  - **首选：轮换那个凭据**（旧密码作废，历史里的就失效了）—— 简单且彻底
  - 或重写历史（`git filter-repo` / `filter-branch`）+ 强推 —— 仅适合**无协作者、刚建**的仓库
  - 注意：重写历史会改变所有 commit hash，其他人需重新 clone
- **来源**：某博客项目（2026-04，用户选择暂不处理）

### git · 首次推送被拒（远程已有内容）
- **症状**：`! [rejected] main -> main (fetch first)`
- **原因**：建仓库时自动生成了 `README.md` / `LICENSE`，远程已有提交
- **修法**：`git pull --rebase origin main` 把本地提交接到远程之后；
  README 冲突时注意 **rebase 的 ours/theirs 语义与 merge 相反**：
  - `--ours` = **正在 rebase 到的分支**（远程）
  - `--theirs` = **你正在应用的提交**（本地）
- **来源**：某博客项目 + agent-constraints（2026-04，两次都遇到）

---

## 平台相关

### git · `git add` 整体失败，报某个文件无法索引
- **症状**：`error: open("...nul"): No such file or directory` +
  `fatal: adding files failed` —— 而且**其他文件也全没 add 上**
- **原因**：目录里有 **Windows 保留设备名**文件（`nul` / `con` / `aux` / `com1` / `lpt1`），
  某次 `> nul` 重定向误创建。保留名让 git 无法索引，**一个坏文件拖垮整个 add**
- **修法**：删掉它（普通路径访问不了保留名，要用 `\\?\` 前缀）：
  ```powershell
  [System.IO.File]::Delete('\\?\F:\path\to\nul')
  ```
  然后重新 `git add -A`
- **来源**：某博客项目（2026-04，推送前卡在这里）

### git · 行尾符反复提示 warning
- **症状**：每次操作都刷 `LF will be replaced by CRLF the next time Git touches it`
- **原因**：`core.autocrlf` 配置与文件实际行尾不一致
- **修法**：**警告本身无害**（git 会自动转换）。
  但**脚本文件要小心**：`.sh` 必须是 LF，否则 bash 执行报错（见 shell.md）
- **来源**：通用经验
