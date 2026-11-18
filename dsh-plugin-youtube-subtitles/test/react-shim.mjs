/** 够真实的 React 替身：useState 持久化、useEffect 按依赖变化触发、useCallback 记忆化。 */
export function createReact() {
  let renderIndex = 0
  const stateSlots = new Map()
  const memoSlots = new Map()
  const effects = []   // { deps, cleanup, id }
  let effectCursor = 0

  const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  const React = {
    createElement: (type, props, ...children) => ({
      type: typeof type === 'string' ? type : (type && (type.displayName || type.name)) || 'Component',
      impl: typeof type === 'function' ? type : undefined,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState(init) {
      const i = renderIndex++
      if (!stateSlots.has(i)) stateSlots.set(i, init)
      return [stateSlots.get(i), (v) => stateSlots.set(i, typeof v === 'function' ? v(stateSlots.get(i)) : v)]
    },
    useCallback(fn, deps) {
      const i = renderIndex++
      const prev = memoSlots.get(i)
      if (prev && depsEqual(prev.deps, deps)) return prev.fn
      memoSlots.set(i, { fn, deps })
      return fn
    },
    useEffect(fn, deps) {
      const i = effectCursor++
      const prev = effects[i]
      if (prev && depsEqual(prev.deps, deps)) return
      if (prev?.cleanup) { try { prev.cleanup() } catch {} }
      const cleanup = fn()
      effects[i] = { deps, cleanup }
    },
    /** 手动触发一次「依赖变化后的重渲染」。 */
    beginRender() { renderIndex = 0; effectCursor = 0 },
    flushCleanups() { for (const e of effects) if (e?.cleanup) { try { e.cleanup() } catch {} } effects.length = 0 },
  }
  return React
}
