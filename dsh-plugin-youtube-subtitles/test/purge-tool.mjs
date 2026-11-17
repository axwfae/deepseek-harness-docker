/** 验证 purge 工具：预览列出 bin/models，confirm 后全部删除。 */
const mod = await import('/home/node/workspace/system/plungin_yt/dsh-plugin-youtube-subtitles/src/index.js')
const fs = await import('node:fs/promises')
const path = await import('node:path')

const root = '/tmp/yt-purge-tool'
await fs.rm(root, { recursive: true, force: true })
await fs.mkdir(path.join(root, 'bin'), { recursive: true })
await fs.mkdir(path.join(root, 'models', 'small'), { recursive: true })
await fs.writeFile(path.join(root, 'bin', 'yt-dlp'), 'x'.repeat(3_000_000))
await fs.writeFile(path.join(root, 'bin', 'ffmpeg'), 'x'.repeat(80_000_000))
await fs.writeFile(path.join(root, 'models', 'small', 'model.int8.onnx'), 'x'.repeat(74_000_000))
await fs.writeFile(path.join(root, 'models', 'silero_vad.onnx'), 'x'.repeat(600_000))

const config = mod.Config['~standard'].validate({ dataRoot: root }).value
const tools = new Map()
mod.apply({ logger: { info: () => {}, warn: () => {} }, get: (n) => (n === 'tools' ? { register: (d) => { tools.set(d.name, d); return () => {} } } : undefined), effect: (fn) => fn() }, config)

const purge = tools.get('youtube_subs_purge')
const preview = await purge.execute({}, {})
console.log('=== 预览 ===')
console.log('总占用:', preview.occupiedMB, 'MB')
console.log('binaries:', JSON.stringify(preview.binaries))
console.log('models:', JSON.stringify(preview.models))
console.log('willDelete:', JSON.stringify(preview.willDelete, null, 1))

const done = await purge.execute({ confirm: true }, {})
console.log('\n=== 执行 ===')
console.log('removed:', done.removed, '| freedMB:', done.freedMB)
console.log('deleted:', JSON.stringify(done.deleted))
console.log('note:', done.note)
console.log('目录还在:', await fs.stat(root).then(() => true).catch(() => false))

// 空目录场景
const empty = '/tmp/yt-purge-empty'
await fs.rm(empty, { recursive: true, force: true })
await fs.mkdir(empty, { recursive: true })
const config2 = mod.Config['~standard'].validate({ dataRoot: empty }).value
const tools2 = new Map()
mod.apply({ logger: { info: () => {}, warn: () => {} }, get: (n) => (n === 'tools' ? { register: (d) => { tools2.set(d.name, d); return () => {} } } : undefined), effect: (fn) => fn() }, config2)
const p2 = await tools2.get('youtube_subs_purge').execute({}, {})
console.log('\n=== 空目录预览 ===')
console.log('binaries:', JSON.stringify(p2.binaries))
console.log('models:', JSON.stringify(p2.models))
