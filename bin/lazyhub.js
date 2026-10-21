if (process.argv.includes('--version') || process.argv.includes('-v')) {
  const { readFileSync } = await import('fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

if (process.argv.includes('--mouse')) {
  process.env.LAZYHUB_MOUSE = '1'
}

if (process.argv.includes('--debug-state')) {
  const { printDebugState } = await import('../src/debug-state.js')
  const dump = printDebugState()
  process.stdout.write(`${JSON.stringify(dump, null, 2)}\n`)
  process.exit(0)
}

if (process.argv[2] === 'perf' && process.argv[3] === 'report') {
  const { readPerfReport } = await import('../src/perf.js')
  const rows = readPerfReport()
  if (rows.length === 0) {
    process.stdout.write('No perf data found. Run with LAZYHUB_PERF=1 first.\n')
    process.exit(0)
  }
  process.stdout.write('op\tcount\tp50\tp95\tmax\n')
  for (const row of rows) {
    process.stdout.write(`${row.op}\t${row.count}\t${row.p50.toFixed(1)}\t${row.p95.toFixed(1)}\t${row.max.toFixed(1)}\n`)
  }
  process.exit(0)
}

// MCP server mode: lazyhub --mcp
// Speaks Model Context Protocol over stdio so AI assistants can query/act on GitHub data.
if (process.argv.includes('--mcp')) {
  const { runMcpServer } = await import('../src/cli/mcp-server.js')
  process.exit(await runMcpServer())
}

if (process.argv[2] === 'doctor') {
  const { runDoctor } = await import('../src/cli/doctor/index.js')
  process.exit(await runDoctor(process.argv.slice(3)))
}

if (process.argv[2] === 'watch-only') {
  const { runWatchOnly } = await import('../src/cli/watch-only.js')
  process.exit(await runWatchOnly(process.argv.slice(3)))
}

if (process.argv[2] === 'serve') {
  const { runServe } = await import('../src/cli/serve.js')
  process.exit(await runServe(process.argv.slice(3)))
}

if (process.argv[2] === 'status') {
  const { runStatus } = await import('../src/cli/status.js')
  process.exit(await runStatus(process.argv.slice(3)))
}

if (process.argv[2] === 'mcp-server') {
  const { runMcpServer } = await import('../src/cli/mcp-server.js')
  process.exit(await runMcpServer())
}

const { bootstrap } = await import('../src/bootstrap.js')
const { installCrashHandlers } = await import('../src/crash.js')
const { renderApp } = await import('../src/app.jsx')
const { loadConfig } = await import('../src/config.js')
const { startIPC } = await import('../src/ipc.js')
const { ensureDaemon } = await import('../src/daemon/lifecycle.js')

const cfg = loadConfig()
installCrashHandlers()

await ensureDaemon(cfg, new URL('./lazyhub.js', import.meta.url).pathname)

// Start IPC server for IDE integrations (unless disabled in config)
if (cfg.ipc?.enabled !== false) {
  const socketPath = startIPC()
  if (socketPath) process.env.LAZYHUB_SOCKET = socketPath
}

await bootstrap(renderApp)
