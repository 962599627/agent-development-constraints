// agent-development-constraints 的浏览器端：插件配置卡片。
//
// ## 模块格式（lazy-CJS bundle protocol）
//
// 照 @liustack/modlens 的 dsh/client.js —— 手写，**不需要构建步骤**：
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
// factory 返回 cordis-plugin 形状的 exports（apply / inject）。
//
// 为什么不用打包：modlens 的注释写明这套协议"no build step and no imports
// from dsh client packages"，host 半和 client 半都是零依赖立场。
// 对本插件尤其重要 —— 已经因为"多声明一个依赖"崩过一次宿主会话了。
//
// ## 挂载位置
//
// dsh 0.1.7 起插件配置卡片在 **Plugins 页**，通过 `plugins.bundle.config`
// 这个 slot 分发，**key 是包名**（见 modlens 的同名注册）。
// 旧版还有 `settings.plugin.item`，两处都注册，各主机各取所需。
//
// ## 卡片内容
//
// 目前是**只读状态**：插件版本、规则库位置、注入开关的当前值。
// 之所以先做只读，是为了先验证"客户端 bundle 能被加载"这条全新链路 ——
// 读写的 Host API 通信是下一步。
//
// 所有 DOM 都直接建，不依赖 ui 组件库的具体导出名，避免猜错。

window.__ModuleLoader__.load({
  id: 'agent-development-constraints',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // 由 host 半在构建/加载时无法提供，这里内联常量。
    // 状态里的"规则库位置"需要向 host 询问，见 fetchStatus。
    var PKG = 'agent-development-constraints'
    var VERSION = '0.9.0'

    /** 从 Host 侧拿运行时状态；失败时返回 null（卡片降级为只显示静态信息） */
    function fetchStatus() {
      // Host 半注册的状态路由（见 index.mjs 的 registerStatusRoute）
      return fetch('/' + PKG + '/status', { headers: { accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) return null
          return res.json()
        })
        .catch(function () {
          return null
        })
    }

    /**
     * 写配置。
     *
     * Host 侧对请求体做了白名单：只接受 `{ inject: boolean }`，
     * 其它字段一律忽略 —— 所以这里也不要发送多余的东西。
     */
    function saveConfig(patch) {
      return fetch('/' + PKG + '/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
        .then(function (res) {
          return res.json().catch(function () {
            return null
          })
        })
        .catch(function () {
          return null
        })
    }

    /**
     * 建卡片组件。
     *
     * `react` 由 require('react') 运行时提供（lazy-CJS 协议里的 require）。
     * 用 createElement 而不写 JSX —— 手写文件没有转译步骤。
     */
    function makeCard(react) {
      var h = react.createElement

      var palette = {
        text: 'var(--dsw-alias-label-primary, #e6e6e6)',
        dim: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))',
        border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.22))',
        bg: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
      }

      function row(label, value) {
        return h(
          'div',
          {
            key: label,
            style: { display: 'flex', gap: '8px', alignItems: 'baseline', marginTop: '6px' },
          },
          h('span', { style: { color: palette.dim, flex: '0 0 96px', fontSize: '12px' } }, label),
          h(
            'span',
            {
              style: {
                color: palette.text,
                fontSize: '12px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                wordBreak: 'break-all',
              },
            },
            value
          )
        )
      }

      return function ConstraintsCard(props) {
        var state = react.useState(null)
        var status = state[0]
        var setStatus = state[1]
        var errState = react.useState(null)
        var err = errState[0]
        var setErr = errState[1]
        var busyState = react.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]

        react.useEffect(function () {
          var alive = true
          fetchStatus()
            .then(function (s) {
              if (!alive) return
              setStatus(s)
            })
            .catch(function (e) {
              if (alive) setErr(String((e && e.message) || e))
            })
          return function () {
            alive = false
          }
        }, [])

        /** 切换注入开关；写成功后本地立即反映，不等重新拉取 */
        function toggleInject(next) {
          setBusy(true)
          setErr(null)
          saveConfig({ inject: next })
            .then(function (r) {
              if (!r || !r.ok) throw new Error((r && r.error) || '保存失败')
              setStatus(function (prev) {
                return Object.assign({}, prev, { injectEnabled: r.config.inject })
              })
            })
            .catch(function (e) {
              setErr(String((e && e.message) || e))
            })
            .then(function () {
              setBusy(false)
            })
        }

        // Plugins 页会自己画标题和面包屑，并传 view: 'page' —— 那里只画表单。
        var isPage = props && props.view === 'page'

        var children = []

        if (!isPage) {
          children.push(
            h(
              'div',
              { key: 'title', style: { fontSize: '14px', fontWeight: 600, color: palette.text } },
              '开发约束（agent-constraints）'
            )
          )
        }

        children.push(
          h(
            'div',
            { key: 'desc', style: { color: palette.dim, fontSize: '12px', marginTop: '4px' } },
            '把项目的开发约束规则库暴露给 AI：注册 constraints 工具，并在会话开始时提醒一次。'
          )
        )

        // ---------- 开关 ----------
        var injectOn = Boolean(status && status.injectEnabled)
        children.push(
          h(
            'label',
            {
              key: 'toggle',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginTop: '12px',
                cursor: busy || !status ? 'default' : 'pointer',
                color: palette.text,
                fontSize: '13px',
              },
            },
            h('input', {
              type: 'checkbox',
              checked: injectOn,
              disabled: busy || !status,
              onChange: function (e) {
                toggleInject(Boolean(e.target.checked))
              },
              style: { width: '15px', height: '15px', cursor: 'inherit' },
            }),
            '会话开始时提醒我查阅约束',
            busy
              ? h('span', { style: { color: palette.dim, fontSize: '12px' } }, '（保存中…）')
              : null
          )
        )

        children.push(
          h(
            'div',
            { key: 'hint', style: { color: palette.dim, fontSize: '11.5px', marginTop: '4px' } },
            '每个会话只提醒一次，约 41 tokens。关闭后只保留 constraints 工具（按需调用，零常驻成本）。'
          )
        )

        // ---------- 状态 ----------
        children.push(
          h(
            'div',
            {
              key: 'body',
              style: {
                marginTop: '12px',
                padding: '10px 12px',
                border: '1px solid ' + palette.border,
                borderRadius: '10px',
                background: palette.bg,
              },
            },
            row(
              '规则库位置',
              status && status.constraintsPath
                ? status.constraintsPath
                : '未检测到（本会话目录下没有 agent-constraints/）'
            ),
            row(
              '会话目录',
              status && status.cwd
                ? status.cwd +
                    (status.cwdSource === 'process' ? '（进程 cwd，尚未收到会话消息）' : '')
                : '（等待宿主上报）'
            ),
            row('插件版本', (status && status.version) || VERSION),
            status && status.configFile ? row('配置文件', status.configFile) : null,
            err ? row('出错', err) : null
          )
        )

        // ---------- 成本 ----------
        // 数据来自 DSH 自己的用量账本（usage-ledger.json），只读不改。
        // 摆出来是因为：看不见的成本没法优化。
        var cost = status && status.cost
        if (cost) {
          var cacheRatio =
            cost.todayInputTokens > 0
              ? (cost.todayCacheReadTokens / cost.todayInputTokens).toFixed(1) + '×'
              : '—'
          children.push(
            h(
              'div',
              {
                key: 'cost',
                style: {
                  marginTop: '10px',
                  padding: '10px 12px',
                  border: '1px solid ' + palette.border,
                  borderRadius: '10px',
                  background: palette.bg,
                },
              },
              row('今日成本', (cost.todayCost || 0).toFixed(2) + ' ' + (cost.currency || '')),
              row('今日调用', String(cost.todayCalls || 0) + ' 次'),
              row('今日 tokens', '入 ' + (cost.todayInputTokens || 0) + ' / 出 ' + (cost.todayOutputTokens || 0)),
              row('缓存读取', (cost.todayCacheReadTokens || 0) + '（是输入的 ' + cacheRatio + '）'),
              cost.balance ? row('账户余额', cost.balance + ' ' + (cost.currency || '')) : null
            )
          )
        }

        return h(
          'div',
          { style: { padding: isPage ? '0' : '12px 14px' } },
          children.filter(Boolean)
        )
      }
    }

    /** 把卡片挂到各个 slot 上 */
    function mountCard(scope) {
      var react
      try {
        react = require('react')
      } catch (error) {
        console.error('[agent-constraints] settings card skipped (no react): ' + error)
        return
      }

      var Card = makeCard(react)

      // 用 generator + yield 注册：slots.inject 等待 slot 被声明，
      // 所以每个主机在它自己的设置界面里挂载这张卡片。
      // 照抄已装插件的写法 —— 这是唯一经过验证的形式。
      function registerTo(slotName, descriptor) {
        try {
          scope.slots.inject(slotName, function* () {
            yield scope.slots.register(descriptor, Card)
          })
        } catch (error) {
          console.error('[agent-constraints] slot ' + slotName + ' 注册失败: ' + error)
        }
      }

      // ---------- 主入口：设置页左侧的独立条目 ----------
      //
      // slot 名 `settings.section`，字段照 @linxin666/dsh-web-all 的两处用法
      // （lib/client.js:788 与 :4082）：{ name, id, order, label, locale?, children? }
      //
      // ⚠️ 这里**故意不传 locale** —— 传了就要在 host 侧注册对应的本地化字典；
      // 而 label 是函数、可以直接返回字符串，少一个依赖少一个坑。
      // （本插件已经因为"多一个依赖"崩过一次宿主会话。）
      registerTo('settings.section', {
        name: 'settings.section',
        id: PKG,
        order: 200,
        label: function () {
          return '开发约束'
        },
      })

      // ---------- 兼容：0.1.7+ 的 Plugins 页 ----------
      // 有些主机把插件配置收进 Plugins 页（modlens 就挂那里）。
      // 两个都挂，交给主机决定在哪里展示。
      registerTo('plugins.bundle.config', {
        name: 'plugins.bundle.config',
        key: PKG,
      })

      // ---------- 兼容：更老的 settings.plugin.item ----------
      registerTo('settings.plugin.item', {
        name: 'settings.plugin.item',
        id: PKG,
        key: PKG,
        order: 40,
      })
    }

    function registerCard(ctx) {
      // cordis 里访问未声明的服务会抛错，所以每个可选依赖各走一次
      // scoped ctx.inject：服务存在时闭包才跑，不存在就完全不跑。
      if (typeof ctx.inject !== 'function') return
      try {
        ctx.inject(['slots'], function (scope) {
          try {
            mountCard(scope)
          } catch (error) {
            console.error('[agent-constraints] 卡片挂载失败: ' + error)
          }
        })
      } catch (error) {
        console.error('[agent-constraints] slots 服务不可用: ' + error)
      }
    }

    function apply(ctx) {
      try {
        registerCard(ctx)
      } catch (error) {
        // 卡片失败绝不影响其它东西
        console.error('[agent-constraints] client apply 失败: ' + error)
      }
    }

    exports.apply = apply
    // slots 是可选服务，走各自的 scoped inject，所以这里声明空数组
    exports.inject = []
    return module.exports
  },
})
