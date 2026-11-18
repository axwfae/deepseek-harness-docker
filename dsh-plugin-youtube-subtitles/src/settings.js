/**
 * 档位覆盖：让「对话式切换」与「设置界面/配置文件」共存而不打架。
 *
 * 背景：
 *   `_2` 把档位完全交给 DSH 的 Config（volatile 字段），于是 `youtube_subs_status`
 *   失去了 `setTier` —— 用户说「切换到全能模型」时，Agent 只能去改 profile patch
 *   或请用户自己开设置页。v1.6.0 把这条对话路径补回来。
 *
 * 为什么不是一个 `settings.json` 全量副本：
 *   全量副本会让「界面里存的」和「配置文件里的」变成两套真相，谁生效说不清。
 *   这里只记录**一次由工具发起的切换**，并且记下发起时的 Config 值：
 *
 *     { "tier": "full", "configTier": "small" }
 *
 *   生效规则：只有当 Config 的档位仍等于 `configTier` 时，覆盖才生效。
 *   一旦有人在设置界面或 `cordis.patch.yml` 里改了档位，`configTier` 不再匹配，
 *   覆盖自动失效（Config 获胜），不会出现「界面改了却没反应」。
 *
 * 清除：`youtube_subs_status({ setTier: "config" })` 删除覆盖文件。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { MODEL_TIERS } from './asr.js'

/** 覆盖文件名（放在插件自己的 dataRoot 下）。 */
export const OVERRIDE_FILENAME = 'tier-override.json'

/**
 * 覆盖文件的绝对路径。
 * @param {string} dataRoot
 * @returns {string}
 */
export function overridePath(dataRoot) {
  return join(dataRoot, OVERRIDE_FILENAME)
}

/**
 * 读取覆盖记录（同步、容错）。
 *
 * 同步是刻意的：`rt.tier()` 在每次工具调用里都要读，异步会把整条链路染成 async；
 * 文件只有几十字节，读取成本可以忽略。损坏或不存在一律当作「没有覆盖」。
 *
 * @param {string} dataRoot
 * @returns {{tier: string, configTier: string} | null}
 */
export function readTierOverride(dataRoot) {
  const file = overridePath(dataRoot)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    if (!Object.hasOwn(MODEL_TIERS, raw.tier)) return null
    // configTier 允许缺失：旧文件或手写文件按「不生效」处理
    const configTier = typeof raw.configTier === 'string' ? raw.configTier : ''
    return { tier: raw.tier, configTier }
  } catch {
    return null
  }
}

/**
 * 写入覆盖记录（先写临时文件再 rename，避免半截 JSON）。
 *
 * @param {string} dataRoot
 * @param {string} tier - small / full
 * @param {string} configTier - 发起切换时 Config 里的档位
 * @returns {Promise<string>} 写入的绝对路径
 */
export async function writeTierOverride(dataRoot, tier, configTier) {
  if (!Object.hasOwn(MODEL_TIERS, tier)) {
    throw new Error(`未知模型档位：${tier}（可选 ${Object.keys(MODEL_TIERS).join(' / ')}）`)
  }
  const file = overridePath(dataRoot)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, `${JSON.stringify({ tier, configTier }, null, 2)}\n`, 'utf8')
  await rename(temp, file)
  return file
}

/**
 * 删除覆盖记录（幂等）。
 * @param {string} dataRoot
 * @returns {Promise<boolean>} 是否真的删掉了文件
 */
export async function clearTierOverride(dataRoot) {
  const file = overridePath(dataRoot)
  if (!existsSync(file)) return false
  await rm(file, { force: true })
  return true
}

/**
 * 计算生效档位。
 *
 * @param {string} configTier - Config 里的档位（可能为空/非法）
 * @param {{tier: string, configTier: string} | null} override - 覆盖记录
 * @param {string} defaultTier - 兜底档位
 * @returns {{tier: string, source: 'override' | 'config' | 'default', stale: boolean}}
 */
export function resolveTier(configTier, override, defaultTier) {
  const configValid = Object.hasOwn(MODEL_TIERS, configTier)
  if (override && override.tier && override.configTier === configTier) {
    return { tier: override.tier, source: 'override', stale: false }
  }
  if (configValid) {
    return { tier: configTier, source: 'config', stale: Boolean(override) }
  }
  return { tier: defaultTier, source: 'default', stale: Boolean(override) }
}
