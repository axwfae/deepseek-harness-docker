// End-to-end smoke test for the plugin without the DSH runtime: mount the
// plugin against a fake `ctx`, then call the registered tools in order.
//
//   node test/smoke.mjs [host] [port]
import { apply } from '../dsh/index.js'

const host = process.argv[2] ?? 'lightpanda'
const port = Number(process.argv[3] ?? 9222)

const tools = new Map()
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
  effect: () => () => {},
}
const configPath = new URL('./out/config.json', import.meta.url).pathname
apply(ctx, { host, port, hostHeader: `127.0.0.1:${port}`, timeoutMs: 30_000, configPath })

const call = async (name, args) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} was not registered`)
  const value = await tool.execute(args, { signal: new AbortController().signal })
  const rendered = tool.output.render(args, value)
  console.log(`\n=== ${name} ${JSON.stringify(args ?? {})}`)
  console.log(rendered[0].text.slice(0, 700))
  return value
}

const ok = (label, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`)
  if (!condition) process.exitCode = 1
}

console.log('registered tools:', [...tools.keys()].join(', '))

const shown = await call('lp_config', { action: 'show' })
ok('lp_config show resolves the configured endpoint', shown.endpoint.host === host && shown.sources.host === 'config')
ok('lp_config show probes the endpoint', shown.probe.ok === true)

const saved = await call('lp_config', { action: 'set', host, port })
ok('lp_config set persists the file', saved.sources.host === 'file' && saved.probe.ok === true)

const afterReset = await call('lp_config', { action: 'reset' })
ok('lp_config reset drops the file', afterReset.sources.host === 'config')

const status = await call('lp_status')
ok('lp_status reports a version', Boolean(status.browser || status.lightpanda))

const opened = await call('lp_open', { url: 'https://example.com/' })
ok('lp_open returns a target id', typeof opened.targetId === 'string')
ok('lp_open reports the title', opened.title === 'Example Domain')
const targetId = opened.targetId

// Fresh connection state must survive between calls: this uses the same target.
const read = await call('lp_read', { targetId, format: 'markdown', maxChars: 2000 })
ok('lp_read returns markdown body', read.content.includes('documentation examples') || read.content.includes('Example Domain'))
ok('lp_read keeps the same tab', read.targetId === targetId)

const textRead = await call('lp_read', { targetId, format: 'text', maxChars: 400 })
ok('lp_read text uses innerText', typeof textRead.content === 'string' && textRead.content.length > 20)

const evaluated = await call('lp_eval', { targetId, expression: 'document.title' })
ok('lp_eval returns the title', evaluated.value === 'Example Domain')

const elements = await call('lp_elements', { targetId, tag: 'a', max: 5 })
ok('lp_elements lists anchors', elements.returned > 0 && elements.elements.every((entry) => entry.tag === 'a'))

const clicked = await call('lp_act', { targetId, action: 'click', selector: 'a' })
ok('lp_act click navigates', clicked.url !== 'https://example.com/')

// The implicitly-reused tab path: no targetId means "the last used tab".
const statusOfTab = await call('lp_status', {})
ok('lp_status lists the live tab', statusOfTab.targets.some((tab) => tab.targetId === targetId))

const shot = await call('lp_shot', { targetId, path: 'test/out/smoke.png' })
ok('lp_shot writes a PNG', shot.bytes > 1000)

// Fill a real form control on a page that has one, then read the value back.
const formPage = await call('lp_open', { url: 'https://www.bing.com/' })
const filled = await call('lp_act', {
  targetId: formPage.targetId,
  action: 'fill',
  selector: '#sb_form_q',
  text: 'lightpanda cdp',
})
ok('lp_act fill succeeds', filled.ok === true)
const value = await call('lp_eval', {
  targetId: formPage.targetId,
  expression: 'document.querySelector("#sb_form_q").value',
})
ok('lp_act fill sets the value', value.value === 'lightpanda cdp')
await call('lp_close', { targetId: formPage.targetId })

const closed = await call('lp_close', { targetId })
ok('lp_close closes the tab', closed.closed === true)

console.log('\nAll checks executed.')
