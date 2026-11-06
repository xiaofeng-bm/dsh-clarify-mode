/**
 * Browser half of dsh-clarify-mode: a composer chip that shows the interview
 * state and turns the mode off in one click.
 *
 * The host ships this file verbatim, so it is hand-written in the module-loader
 * format rather than compiled from JSX. It registers into
 * `conversation.input.left` — the list-kind slot rendered beside the permission
 * and plan chips, which are single-kind and therefore already taken.
 */

window.__ModuleLoader__.load({
  id: 'dsh-clarify-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    /** Client services this plugin needs before it can register a slot. */
    const inject = ['slots', 'remote', 'remote.commands']

    const chipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '28px',
      padding: '0 8px',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'var(--dsw-alias-state-business-tertiary, rgba(64, 128, 255, 0.12))',
      color: 'var(--dsw-alias-state-business-primary, #2a6fdb)',
      border: 'none',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '13px',
      fontWeight: '500',
      lineHeight: '20px',
      whiteSpace: 'nowrap',
    }

    const closeStyle = { opacity: '0.55', fontSize: '11px' }

    /**
     * Render the active interview as a compact chip.
     *
     * @param props.useProjection - Ambient reader for one host projection key.
     * @param props.locked - Whether the composer is refusing input right now.
     * @param props.exitClarifyMode - Resolves to an error string, or null.
     * @returns The chip while the mode is active, otherwise null.
     */
    function ClarifyChip({ useProjection, locked, exitClarifyMode }) {
      const state = useProjection('clarify')
      const [leaving, setLeaving] = react.useState(false)

      if (state === void 0 || state.active !== true) return null

      const asked = typeof state.asked === 'number' ? state.asked : 0

      const off = () => {
        setLeaving(true)
        Promise.resolve(exitClarifyMode()).then(
          () => setLeaving(false),
          () => setLeaving(false),
        )
      }

      return react.createElement(
        'button',
        {
          type: 'button',
          style: chipStyle,
          disabled: locked === true || leaving,
          onClick: off,
          title: `需求澄清模式进行中（已问 ${asked} 个问题）— 点击退出（/clarify off）`,
          'aria-label': `需求澄清模式进行中，已问 ${asked} 个问题，按下退出`,
        },
        asked === 0 ? '澄清中' : `澄清 · 已问 ${asked}`,
        react.createElement('span', { style: closeStyle, 'aria-hidden': 'true' }, '✕'),
      )
    }

    /**
     * Register the chip beside the composer's other mode controls.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'dsh-clarify-mode',
            inject: (sessionId) => ({
              exitClarifyMode: async () => {
                const result = await ctx.remote.commands.execute(sessionId, '/clarify off', [])
                if (result.ok === false) return `${result.error.message} (${result.error.code})`
                return null
              },
            }),
          },
          ClarifyChip,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
