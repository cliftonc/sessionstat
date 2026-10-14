import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectBilling } from '../src/billing.js'
import { readSession, recordSession } from '../src/sessions.js'
import { useTempHome } from './helpers.js'

let env: Awaited<ReturnType<typeof useTempHome>>
beforeEach(async () => {
  env = await useTempHome()
})
afterEach(async () => env.restore())

const writeAccount = (dir: string, oauthAccount: unknown) =>
  writeFile(join(dir, '.claude.json'), JSON.stringify({ oauthAccount }))

describe('detecting who pays', () => {
  it('is a subscription when the logged-in account is billed by plan', async () => {
    await writeAccount(env.home, { billingType: 'stripe_subscription' })
    expect(await detectBilling({})).toBe('subscription')
  })

  it('is api for any other logged-in account', async () => {
    await writeAccount(env.home, { billingType: 'prepaid' })
    expect(await detectBilling({})).toBe('api')
  })

  it('lets an API key or cloud provider in the environment override the subscription', async () => {
    await writeAccount(env.home, { billingType: 'stripe_subscription' })
    expect(await detectBilling({ ANTHROPIC_API_KEY: 'x' })).toBe('api')
    expect(await detectBilling({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('api')
  })

  it('reads CLAUDE_CONFIG_DIR when set', async () => {
    const dir = join(env.home, 'alt')
    await mkdir(dir)
    await writeAccount(dir, { billingType: 'stripe_subscription' })
    expect(await detectBilling({ CLAUDE_CONFIG_DIR: dir })).toBe('subscription')
  })

  it('is unknown with nothing to go on', async () => {
    expect(await detectBilling({})).toBe('unknown')
  })
})

describe('the session record', () => {
  const obs = {
    sessionId: 's1',
    transcriptPath: '/t.jsonl',
    cwd: '/r',
    repoRoot: '/r',
    remote: null,
    branch: 'main',
  }

  it('keeps a known billing mode when a later hook cannot tell', async () => {
    await recordSession({ ...obs, billing: 'subscription' })
    await recordSession({ ...obs, billing: 'unknown' })
    expect((await readSession('s1'))?.billing).toBe('subscription')
    await recordSession({ ...obs, billing: 'api' })
    expect((await readSession('s1'))?.billing).toBe('api')
  })
})
