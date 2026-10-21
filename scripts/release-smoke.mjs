#!/usr/bin/env node
// Post-publish smoke test for a published lazyhub version.
//
// Usage: node scripts/release-smoke.mjs <version> [--package lazyhub]
//
// Downloads the exact tarball from the registry (not the build workspace) and
// checks: its integrity matches the registry record, a SLSA provenance
// attestation exists, `npm audit signatures` passes for a clean registry
// install, tarball contents match an allowlist, and the installed binary
// reports the expected version. Exits non-zero on any failure.
// Subprocesses use execFileSync with array args only.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const version = args.find((a) => !a.startsWith('--'))
const pkgIdx = args.indexOf('--package')
const pkg = pkgIdx >= 0 ? args[pkgIdx + 1] : 'lazyhub'

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || !pkg) {
  console.error('usage: release-smoke.mjs <version> [--package <name>]')
  process.exit(2)
}

const spec = `${pkg}@${version}`
const ALLOWED = [
  /^package\/package\.json$/,
  /^package\/README(\.md)?$/,
  /^package\/LICENSE(\.md)?$/,
  /^package\/CHANGELOG\.md$/,
  /^package\/dist\//,
]
const failures = []
const fail = (msg) => { failures.push(msg); console.error(`FAIL: ${msg}`) }
const ok = (msg) => console.log(`ok:   ${msg}`)
const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const errText = (err) => `${err.stdout || ''}${err.stderr || ''}` || err.message

const work = mkdtempSync(join(tmpdir(), 'lazyhub-smoke-'))
try {
  // 1. Download the exact published tarball.
  const dl = join(work, 'download')
  mkdirSync(dl)
  const tgzName = run('npm', ['pack', spec, '--silent', '--pack-destination', dl]).trim().split('\n').pop()
  const tgz = join(dl, tgzName)
  ok(`downloaded ${tgzName}`)

  // 2. Integrity of the downloaded bytes equals the registry record.
  const meta = JSON.parse(run('npm', ['view', spec, '--json']))
  const sri = `sha512-${createHash('sha512').update(readFileSync(tgz)).digest('base64')}`
  if (meta.dist?.integrity === sri) ok('tarball integrity matches registry dist.integrity')
  else fail(`integrity mismatch: registry=${meta.dist?.integrity} local=${sri}`)

  // 3. Provenance attestation published and SLSA-typed.
  const attUrl = meta.dist?.attestations?.url
  if (!attUrl) {
    fail('no dist.attestations on registry record (published without provenance)')
  } else {
    const res = await fetch(attUrl)
    const body = res.ok ? await res.json() : null
    const types = (body?.attestations ?? []).map((a) => a.predicateType)
    if (types.some((t) => t.startsWith('https://slsa.dev/provenance/'))) ok('SLSA provenance attestation present')
    else fail(`no SLSA provenance attestation (http ${res.status}, types=${JSON.stringify(types)})`)
  }

  // 4. Registry signatures and attestations verify in a clean registry install.
  const proj = join(work, 'project')
  mkdirSync(proj)
  writeFileSync(join(proj, 'package.json'), '{"name":"smoke","version":"0.0.0","private":true}\n')
  run('npm', ['install', spec, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: proj })
  try {
    // Exits non-zero on any invalid or missing signature/attestation.
    run('npm', ['audit', 'signatures'], { cwd: proj })
    ok('npm audit signatures passed')
  } catch (err) {
    fail(`npm audit signatures failed:\n${errText(err)}`)
  }

  // 5. Tarball inventory against the allowlist.
  const files = run('tar', ['-tzf', tgz]).split('\n').filter(Boolean)
  const unexpected = files.filter((f) => !ALLOWED.some((re) => re.test(f)))
  console.log(`tarball inventory (${files.length} files):\n${files.map((f) => `  ${f}`).join('\n')}`)
  if (unexpected.length) fail(`unexpected files in tarball: ${unexpected.join(', ')}`)
  else ok('tarball contents match allowlist')

  // 6. Installed binary reports the expected version.
  const bin = join(proj, 'node_modules', pkg, 'dist', 'lazyhub.js')
  const reported = run('node', [bin, '--version'], { cwd: proj, timeout: 30000 }).trim()
  if (reported === version) ok(`binary --version reports ${reported}`)
  else fail(`binary --version reported "${reported}", expected "${version}"`)
} catch (err) {
  fail(`unexpected error: ${errText(err)}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed for ${spec}`)
  process.exit(1)
}
console.log(`\nAll smoke checks passed for ${spec}`)
