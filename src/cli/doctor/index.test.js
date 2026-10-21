import { describe, it, expect } from 'vitest'
import { runDoctor } from './index.js'

function sink() {
  const chunks = []
  return { write: s => { chunks.push(s) }, text: () => chunks.join('') }
}

describe('runDoctor', () => {
  it('prints help without running a doctor check', async () => {
    const out = sink()
    const err = sink()
    expect(await runDoctor(['--help'], out, err)).toBe(0)
    expect(out.text()).toContain('Usage: lazyhub doctor [options]')
    expect(out.text()).toContain('--config')
    expect(out.text()).toContain('--coverage')
    expect(out.text()).toContain('--ai')
    expect(out.text()).toContain('--repo OWNER/NAME')
    expect(out.text()).toContain('--json')
    expect(out.text()).toContain('Exit codes:')
    expect(err.text()).toBe('')
  })

  it('rejects --json with both --config and --coverage instead of emitting two documents', async () => {
    const out = sink()
    const err = sink()
    expect(await runDoctor(['--config', '--coverage', '--json'], out, err)).toBe(2)
    expect(out.text()).toBe('')
    expect(err.text()).toMatch(/not both/)
  })
})
