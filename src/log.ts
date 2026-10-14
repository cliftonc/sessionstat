import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { paths } from './paths.js'

/**
 * Copied from guidemode `packages/cli/src/utils/logger.ts`: append-only, rotated at 5 MB with
 * one previous generation, and it never throws - a hook must not fail because logging did.
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

async function rotateIfLarge(file: string): Promise<void> {
  try {
    const { size } = await stat(file)
    if (size < MAX_LOG_BYTES) return
    await rename(file, `${file}.1`)
  } catch {
    // No file yet, or a racing process already rotated it.
  }
}

export async function log(level: LogLevel, message: string): Promise<void> {
  try {
    const file = paths.logFile()
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await rotateIfLarge(file)
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    await appendFile(file, `[${timestamp}] ${level}: ${message}\n`, { mode: 0o600 })
  } catch {
    // Never throw - logging must be silent.
  }
}

export async function readLogTail(lines: number): Promise<string[]> {
  try {
    const content = await readFile(paths.logFile(), 'utf-8')
    return content.split('\n').filter(Boolean).slice(-lines)
  } catch {
    return []
  }
}

export async function lastError(): Promise<string | null> {
  const tail = await readLogTail(2000)
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].includes('] ERROR: ')) return tail[i]
  }
  return null
}
