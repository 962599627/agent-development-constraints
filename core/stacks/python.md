# Python / Django / DRF

## Django

### Django · 跑测试时限流计数互相污染
- **症状**：加了限流/节流之后，**单独跑某个用例通过，跑完整套件大面积失败**，
  报错集中在认证相关的用例（大量 403/429），且失败数量随用例顺序变化
- **原因**：限流计数存在**跨请求共享的缓存**里，测试之间不清空，
  第 N 个之后的用例全部被限流挡住
- **修法**：给共享状态机制加一个**一句话就能关的开关**（如 `settings.RATELIMIT_ENABLE`，
  用 `sys.argv[1] == "test"` 判断测试环境默认关闭），需要验证限流的用例自己 `override_settings` 打开
- **来源**：某博客项目（2026-04，加登录限流后整个套件炸出 37 个错误）→ 已升级为 **R-003 / R-009**

### Django · TruncDate / __date 在 MySQL 上返回 NULL
- **症状**：按日期分组的统计**全是 NULL**，或分组结果只有一条 NULL 记录
  （如 `TruncDate` 返回 `(None, 37)`）
- **原因**：Django 的日期截断依赖数据库的时区转换函数（`CONVERT_TZ`），
  而 MySQL 的**时区表没导入**时该函数返回 NULL
- **修法**：改用**范围过滤 + Python 侧分组**（`filter(created_at__gte=..., created_at__lt=...)`
  再在 Python 里按本地日期归并），不依赖数据库时区表
- **来源**：某博客项目管理后台仪表盘（2026-04）

### Django · 热重载关闭时改代码不生效
- **症状**：改完 Python 代码，行为**完全没变**；重启后立刻正常
- **原因**：服务以 `runserver --noreload`（或 gunicorn 等生产模式）启动，**不会自动重载**
- **修法**：改动后**必须重启进程**再验证。提权运行的实例用常规 `Stop-Process` 杀不掉，
  Windows 下用 WMI：`Invoke-CimMethod -InputObject $proc -MethodName Terminate`
- **来源**：某博客项目（2026-04）→ 已升级为 **R-008**

### Django · 数据库配置写死密码
- **症状**：凭据出现在源码/配置/文档里，随 git 提交泄露
- **修法**：全部走 `os.getenv(...)`，本地值放 `.env`（并确保 `.env` 被忽略）
- **来源**：某博客项目（2026-04，三处明文密码进历史）→ 已升级为 **R-001 / R-002**

---

## DRF

### DRF · 覆写 get_permissions() 让 @action 的 permission_classes 失效
- **症状**：给某个 action 单独写了 `@action(permission_classes=[AllowAny])`，
  但它**仍然要求登录**（返回 401）
- **原因**：一旦在视图类里覆写 `get_permissions()` 并自己 return 列表，
  DRF 就**不再读取 action 上的 `permission_classes`**
- **修法**：在覆写的 `get_permissions()` 里**显式列出每一个自助动作**
  （`if self.action in ("confirm_email_change", ...): return [AllowAny()]`）
- **来源**：某博客项目（2026-04，邮箱验证接口 401，9 个用例失败）

### DRF · 用户可控的过滤参数直接进 ORM 会 500
- **症状**：`?author=abc` / `?id=1.5` / `?page=` 让接口返回 **500**（不是 400）
- **原因**：字符串直接传给 `filter(xxx_id='abc')` 或 `int()` 转换，抛 `ValueError`
- **修法**：进 ORM 前**安全转换**，非法值回退默认分支；**前端的校验拦不住直接构造的 URL**
- **来源**：某博客项目（2026-04，`?follower=abc` 实测 500）→ 已升级为 **R-006**

### DRF · 公开接口默认把用户对象整个序列化出去
- **症状**：**未登录**请求某个公开列表接口，返回里带 `email`、`username`、`is_staff`
  甚至用户的私人设置（通知偏好、主题）
- **原因**：公开接口里直接嵌了完整的 `UserSerializer`
- **修法**：为公开场合单独定义精简序列化器（只给 `id` + 展示名），
  本人视角才返回完整字段；用 `to_representation` 剔除私人字段
- **来源**：某博客项目（2026-04，`/api/profiles/` 未登录可拉全站邮箱）→ 已升级为 **R-007**

### DRF · 序列化器字段类型与前端假设不一致
- **症状**：前端报 `'int' object is not subscriptable` / `xxx is undefined`，
  或列表渲染成空白
- **原因**：`fields = "__all__"` 时，外键序列化成**整数 ID**，
  而前端以为它是嵌套对象（`item.follower.username`）
- **修法**：要嵌套就显式声明子序列化器（`follower_info = CardSerializer(source="follower")`），
  不要依赖默认行为去猜
- **来源**：某博客项目（2026-04，写关注列表测试时踩到）

---

## Python 语言本身

### Python · 把命令输出写到 stderr 会被上层当失败
- **症状**：脚本里**成功**的命令，外层的 PowerShell / CI 却报错、退出码非 0
- **原因**：很多工具把**进度信息**写 stderr，而调用方（如 PowerShell）把 stderr 视为错误
- **修法**：判断成败**看真实结果**（stdout 里的关键行），不要只看退出码
- **来源**：agent-constraints（2026-04，`git push` 成功但退出码 1）

### Python · 常量/配置硬编码进源码
- **症状**：同 R-001
- **修法**：见 `constraints.md` 的 R-001
