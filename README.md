# Agent Development Constraints

**English** | [中文](README.zh-CN.md)

A **self-evolving** constraint system for AI coding agents: it turns the mistakes you
actually hit during development into rules that take effect the *next* time.

**Version**: see [`VERSION`](VERSION) · [Changelog](CHANGELOG.md)

> ⚠️ **这里刻意不写版本号。**
> 曾经写的是 `0.7.0`，而 `VERSION` 早就走到 0.25 —— 十几个版本没人同步，
> 用户在仓库首页看到的永远是旧版本。
> 现在版本只有**一个来源**（`VERSION` 文件），README 只负责指过去。
> 仓库测试 `【R-011】` 会扫 README/docs，再出现硬编码版本号就会失败。

---

## The problem it solves

Most projects keep a development log. But **a log is not a constraint**:

```
job.md: 538 lines of development history
└── "Must follow" section: 2 rules
```

So the same mistakes get re-made. **Lessons were *recorded*, but never *enforced*.**

This package closes the loop `log → rule → enforcement`, and — just as important —
**keeps the rule library from bloating into a document nobody reads**.

---

## Quick start

### Install into a project

**One line, no clone needed:**

```bash
npx agent-development-constraints install
```

That's it — the rules, the workflows and the optional safety net land in
`./agent-constraints/`, and a reference block is added to your `AGENTS.md`.

Other commands:

```bash
npx agent-development-constraints check        # sanitization check (optional safety net)
npx agent-development-constraints contribute   # extract the rules *you* added
npx agent-development-constraints hooks        # enable the pre-commit check
npx agent-development-constraints help
```

**Or install from a clone** (same result — the CLI just forwards to these scripts):

```powershell
# Windows
.\install.ps1 F:\my-project
```

```bash
# Linux / macOS
./install.sh /path/to/project
```

The installer is **idempotent**:

| File | Behaviour on re-install |
|---|---|
| `core/constraints.md` (your rule library) | **Kept, never overwritten** — it's your accumulated asset |
| `core/DISTILL.md` / `PRUNE.md` / `MERGE.md`, `core/stacks/` | Updated (they ship with the package) |
| `templates/` | Updated |
| The reference block in `AGENTS.md` | Refreshed in place (located by HTML markers, never duplicated) |

> Add `--force` to also overwrite the rule library (back it up first).
> Add `--skip-agents` to leave `AGENTS.md` untouched.

### Three things to do after installing

1. **Open `agent-constraints/core/constraints.md`** and delete what doesn't apply —
   especially check the **"Locate by symptom"** table, that's your entry point when something breaks
2. **Open `agent-constraints/core/stacks/`** — the tech-stack pitfall library
   (`python` / `javascript` / `shell` / `git` / `platform`). Replace whole files with your own stack
3. **Commit the rule library to version control** — it evolves with your project

### Daily use (the important part)

```
Feature done / bug fixed
   ↓
Ask: is there anything here that should become a rule that fires automatically next time?
   ↓ yes                                    ↓ no
Run the DISTILL.md workflow                 Done
   ↓
Run the PRUNE.md workflow to check limits
   ↓
Update constraints.md + changelog
```

---

## Directory structure

```
agent-constraints/
├── README.md              English (this file)
├── README.zh-CN.md        中文
├── VERSION                Version
├── CHANGELOG.md           Changelog (incl. the reasoning behind design decisions)
├── CONTRIBUTING.md        How to contribute rules
├── install.ps1 / .sh      Idempotent installer
├── contribute.ps1 / .sh   Extracts *your* new rules using the install-time baseline
├── core/
│   ├── constraints.md     ★ The rule library — the only file the AI must read
│   ├── DISTILL.md         How to distil rules from development history (+ prompt)
│   ├── PRUNE.md           How to fight bloat (+ prompt)
│   ├── MERGE.md           How maintainers merge community rules (+ prompt)
│   └── stacks/            Tech-stack pitfalls, loaded on demand
│       ├── python.md          Python / Django / DRF
│       ├── javascript.md      JS / TS / Vue / Vite
│       ├── shell.md           PowerShell / bash
│       ├── git.md             git
│       └── platform.md        Windows / MySQL / Docker / Redis
├── templates/
│   ├── rule.md            Template for one rule (four required fields)
│   └── session-log.md     Template for a session log (the raw material)
└── examples/
    └── case-study-blog.md    Real case study: rules distilled from a real project
```

---

## Locate by symptom (the fast path)

The rule library opens with a **symptom index**, because when something breaks you
are holding an **error message**, not the name of the language you're writing:

| Symptom | Likely cause | Where |
|---|---|---|
| `Failed to connect ... port 443` but `curl` works | git hanging on HTTP/2 | `stacks/git.md` |
| Exit code 1, but the command actually succeeded | PowerShell treating stderr as failure | `stacks/shell.md` |
| Syntax error + mojibake (`鏅鸿兘`) | `.ps1` missing UTF-8 BOM | `stacks/shell.md` |
| **Passes alone, fails in the full suite** | Shared state (rate limit / cache) pollution | **R-003 / R-009** |
| **No "Edit" button on your own profile** | Identity check using a mutable display name | **R-004** |
| Clicking an inline button **navigates the row** | `<a>` wrapping a `<button>` (invalid HTML) | **R-005** |
| **Two numbers disagree** | Missing consistency assertion | **R-011** |
| **The whole suite is absurdly slow** (tens of seconds) | Fixtures doing production-grade hashing/crypto; frameworks don't downgrade it for you | **R-013** |
| **A scan reports "0 issues" but there are some** | False negative in the scanner itself | **R-014** |
| **Nothing happens and no error either** | The code never ran (e.g. function ref missing the colon) | **R-015** |
| `Maximum recursive updates exceeded` | Writing reactive state inside a render/callback without a "same value → return" guard | **R-015** |

## Symptom lookup: the book's table of contents

The library is not just a list of rules — it opens with a **symptom index**.
When something breaks you are holding a *symptom* (an error message, a weird
behaviour), not the name of a language; so locate by symptom first, then read
the entry.

```bash
constraints action=symptom                     # full index (category + symptom + rule id)
constraints action=symptom q="suite is slow"   # match -> the entry + the full rule text
constraints action=l0                          # iron rules
constraints action=show                        # everything
```

Currently **10 groups**: build/CLI/environment · testing · scanners/audits ·
after changing a data source · API/data/security · UI/interaction ·
plugin/host integration · cost/troubleshooting · multi-copy drift · empty/waiting/failure.

> ⚠️ **Index entries must be written the way the reader describes the problem.**
> The first version split on words and matched substrings; it missed badly —
> the table said "nothing happens, and no error either" while the user typed
> "nothing happens and no error" (one comma apart) and got no hit.
> Now it uses **character-bigram overlap** (Chinese has no word boundaries),
> and "a paraphrase must still match" is locked in as a test.

---

## Sanitization: checked automatically on every commit

**Requirement**: nothing that exposes your own security posture may leave your machine.

**This is enforced by mechanism, not discipline** — "remember to check" always fails eventually.

```powershell
# Enable once after installing
.\agent-constraints\scripts\install-hooks.ps1
```

From then on every `git commit` scans **the files staged in that commit** and
**refuses the commit** when something matches:

```
发现 1 处可能暴露自身安全的信息：
  _hook_test.md
    第 1 行  ←  规则: (?i)(密码|口令|密钥)\s*[:：=]\s*["']?[^\s"']{4,}
      数据库密码: "your_password"
```

**Four categories are blocked**:

| Category | Examples |
|---|---|
| Credentials | assigned passwords / secrets / tokens, `scheme://user:pass@`, private keys |
| **Local paths** | `C:\Users\<name>`, project dirs on a dev drive — these leak your layout |
| Personal data | email addresses, CN mobile numbers |
| Project names | append your own to `.sanitize-deny.txt` |

**Run manually**:

```powershell
.\agent-constraints\scripts\sanitize-check.ps1          # all tracked files
.\agent-constraints\scripts\sanitize-check.ps1 -All     # include untracked (pre-open-source sweep)
```

**False positive?** Add the harmless pattern to the allow-list in `.sanitize-deny.txt`
(lines starting with `!`) rather than loosening the rule.

> ⚠️ **Why before the commit, not before publishing**: sanitization only counts
> **at the moment content enters history**. Once committed it stays in `git log`
> forever — editing the file later does not remove it (see **R-002**).

---

## What it will NOT do

> It is meant to be **a student that keeps learning** — not a guard,
> and certainly not something that pokes around your data.

| It will **not** | How to verify |
|---|---|
| **Go online or upload anything** | Zero network calls — run `grep -rnE 'Invoke-WebRequest\|curl\|wget\|HttpClient\|smtp' --include='*.ps1' --include='*.sh' .` → **no output** |
| **Read files outside your repo** | Only `git ls-files` and paths under `$ROOT`. No browser data, no env secrets, no SSH keys, no chats |
| **Store, cache, or auto-commit** | Results print to the terminal only — no logs, no cache. `contribute` writes **one local file**; committing it is **your** decision |
| **Learn your secrets** | The library accumulates **patterns** ("don't hardcode credentials"), never values. Test: would you be fine making the whole library public? |
| **Lock you in** | The installer is idempotent — `constraints.md` is **never overwritten**. Delete the package anytime and keep your rules |

**The core is learning**: the four-layer rule library plus the
distill / merge / prune workflows. **Sanitization is an optional safety net** —
delete `scripts/`, `.githooks/`, `.sanitize-deny.txt` and everything else still works.

Full commitment: [PRIVACY.md](PRIVACY.md).

---

## The four layers

| Layer | Content | Limit | On a new project |
|---|---|---|---|
| **L0 Iron rules** | Cross-project, costly to violate, **automatable check** | **15** | Keep |
| **L1 Collaboration** | Human↔agent / agent↔agent conventions | — | Keep |
| **L2 Stack pitfalls** | Framework- and tool-specific traps | — | **Replace wholesale** (`core/stacks/`) |
| **L3 Archive** | Retired rules, names kept | — | Keep |

**The 15-rule cap on L0 is hard.** A constraint's value decreases with its length —
past the cap, the agent starts ignoring them, and an ignored rule library is worse than none.

---

## The four required fields

```markdown
### R-0XX One-line imperative name
- **Rule**:      an executable constraint (no "be careful" / "try to" — those can't be checked)
- **Trigger**:   when it should come to mind (list concrete situations)
- **Check**:     how to verify (MUST be a command / grep / assertion — not "review manually")
- **Evidence**:  the real incident that produced it + what it cost
```

**Why all four**:

| Missing | Consequence |
|---|---|
| Rule | Becomes "be careful"-style noise |
| Trigger | The agent never recalls it — equivalent to not existing |
| Check | Only self-discipline; unverifiable |
| Evidence | Future maintainers can't judge importance and delete it while pruning |

**Test**: once written, can you express the violation as a single **assertion** or **command**?
If not, the rule isn't thought through yet.

---

## Why more users make it stronger

This is the **core mechanism**, not a slogan.

**The problem**: if each project only closes its own loop, projects accumulate rules in
isolation — **more users add nothing.**

**The solution: independent sightings**

A rule's **credibility** is determined by *how many projects independently hit the same trap*:

| Independent sightings | Layer |
|---|---|
| 1 | L2 stack pitfalls / project-local |
| 2 | L1 collaboration |
| **≥ 3** | **L0 iron rule** |
| Refuted by ≥ 2 projects | Demoted / archived |

**Why it works**: it is not voting, it is **independent reproduction**. A rule surfacing in
one project may be a quirk; surfacing in **three independent projects** means it captures a
**general human or toolchain failure mode**.

**How data flows**:

```
Main repository (distilled rules)
   ↓ install
Projects A / B / C accumulate their own hard-won lessons
   ↓ contribute (uses the install-time baseline to find *your* additions)
Contribution bundle → maintainer merges per MERGE.md
   ↓ abstract + independent sightings +1
Main repository updated → redistributed to everyone
```

**Abstraction is the key step during merge**:

```
Candidate A: don't hardcode the DB password in Django's settings.py
Candidate B: don't hardcode passwords in Node's docker-compose.yml
Candidate C: don't record the admin password in docs
        ↓ abstract into a higher-order rule (covers all three)
R-001 Never hardcode credentials (source / config / docs / templates)   sightings: 3
```

**Side effect**: the `Sources` field makes rules **deletion-resistant** —
nobody dares prune a rule backed by three independent incidents.

See [`core/MERGE.md`](core/MERGE.md) (maintainer flow) and
[`CONTRIBUTING.md`](CONTRIBUTING.md) (contributor guide).

---

## Design principles

| Decision | Rationale |
|---|---|
| Rules must be executable | A rule you can't check for violation might as well not exist |
| Evidence is mandatory | Evidence is the only thing that keeps a rule from being deleted |
| Hard cap on L0 | Short and accurate > long and complete; prefer 10 rules that are followed |
| Only delete what tooling replaced | Archiving is nearly free; rediscovering a pitfall is expensive |
| Record "not accepted" items | Otherwise the same suggestion gets re-proposed next time |
| Idempotent installer | The user's rule library is an asset; upgrades must not touch it |
| Checkbox at the end of the log template | The most common failure mode of a dev log is that nobody looks back at it |
| Load stack pitfalls on demand | Context is scarce — a bloated library gets ignored wholesale |

---

## Relationship to development logs

This package doesn't **replace** a development log — it's downstream of one:

```
Raw logs (chat sessions / job.md)   ← long, fragmented; humans read, agents don't
        ↓ DISTILL
Rule library (constraints.md)       ← short, precise, executable; the agent always reads it
        ↓ PRUNE
Stable essence                      ← long-lived; copy it straight into new projects
```

**Where does a piece of information belong?**

- **Archaeological value only** (how did we do it back then?) → keep it in the log
- **Will be needed again** → distil it into a rule

---

## Contributing

The most valuable contribution is: **"I independently hit a trap that's already in your library."**
It adds +1 to that rule's independent sightings and can promote it from L1 to L0.

See [`CONTRIBUTING.md`](CONTRIBUTING.md), or run `contribute.ps1` / `contribute.sh`
inside your project to auto-extract the rules you added.

## License

See [LICENSE](LICENSE).
