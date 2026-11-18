/**
 * 字幕格式化回归：时间轴边界与 JSON 数值整洁度。
 *
 * 两个曾经的坑：
 *   1. 秒的小数部分直接 ×1000 取整，会输出 `,1000`（非法 SRT），把整段时间轴写坏；
 *   2. `start + duration` 的浮点噪音（21.880000000000003）直接进 JSON，下游难用。
 */
const yt = await import(new URL('../src/youtube.js', import.meta.url).href)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/* ---------------- SRT / VTT 时间戳边界 ---------------- */
check('SRT 1.9996 → 2.000', yt.toSrtTime(1.9996) === '00:00:02,000', yt.toSrtTime(1.9996))
check('SRT 59.9997 → 01:00.000', yt.toSrtTime(59.9997) === '00:01:00,000', yt.toSrtTime(59.9997))
check('SRT 0 → 0.000', yt.toSrtTime(0) === '00:00:00,000', yt.toSrtTime(0))
check('SRT 负数归零', yt.toSrtTime(-3) === '00:00:00,000', yt.toSrtTime(-3))
check('VTT 1.9996 → 2.000', yt.toVttTime(1.9996) === '00:00:02.000', yt.toVttTime(1.9996))

/* ---------------- SRT / VTT 结构 ---------------- */
const cues = [
  { start: 1.36, end: 3.04, text: '第一句' },
  { start: 18.64, end: 21.880000000000003, text: 'second line' },
]
const srt = yt.toSrt(cues)
check('SRT 序号从 1 开始', srt.startsWith('1\n'), srt.slice(0, 12).replace(/\n/g, '\\n'))
check('SRT 含两段', (srt.match(/ --> /g) ?? []).length === 2)
check('SRT 无非法毫秒', !/,1000/.test(srt))
const vtt = yt.toVtt(cues)
check('VTT 以 WEBVTT 开头', vtt.startsWith('WEBVTT'))

/* ---------------- JSON 数值整洁 ---------------- */
const json = yt.formatCues(cues, 'json')
check('JSON 不含浮点噪音', !/\d\.\d{4,}/.test(json), json.match(/21\.\d+/)?.[0] ?? '')
const parsed = JSON.parse(json)
check('JSON 保留段数与文本', parsed.length === 2 && parsed[1].text === 'second line')
check('JSON 时间四舍五入到毫秒', parsed[1].end === 21.88, String(parsed[1].end))

/* ---------------- 纯文本 ---------------- */
const text = yt.toPlainText(cues)
check('纯文本保留两句', text.includes('第一句') && text.includes('second line'))

/* ---------------- 非法格式 ---------------- */
let threw = false
try {
  yt.formatCues(cues, 'ass')
} catch {
  threw = true
}
check('非法格式明确报错', threw)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
