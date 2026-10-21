import { describe, it, expect } from 'vitest'
import { runDoctor } from './index.js'

function sink() {
  const chunks = []
  return { write: s => { chunks.push(s) }, text: () => chunks.join('') }
}

describe('runDoctor', () => {
  it('rejects --json with both --config and --coverage instead of emitting two documents', async () => {
    const out = sink()
    const err = sink()
    expect(await runDoctor(['--config', '--coverage', '--json'], out, err)).toBe(2)
    expect(out.text()).toBe('')
    expect(err.text()).toMatch(/not both/)
  })
})
