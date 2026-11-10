/**
 * Learning dev loop: one command that keeps a source `dsh web` current.
 *
 * - Client edits: delegated to `pnpm run dev:web --no-serve`; its watchers
 *   rebuild browser bundles and the running page hot-swaps the plugin.
 * - Host edits (`packages/<group>/<pkg>/src/**` outside `client/`): rebuild
 *   Host libraries incrementally, then restart `dsh web` on the same port.
 *   A failed build keeps the previous server running.
 * - `apps/cli/src/**` edits: restart only; the CLI runs from source through tsx.
 *
 * `DSH_HOME` defaults to `~/.dsh-learn` so the production `~/.dsh` is never used
 * by accident. Arguments after the script are forwarded to `dsh web`.
 *
 * Usage: `pnpm run develop [dsh web arguments]`.
 */
import { existsSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import type { ResultPromise } from 'execa'
import { discoverLibraryDirs } from '../scripts/dev-web.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const forwarded = process.argv.slice(2).filter(arg => arg !== '--')
const env = { ...process.env, DSH_HOME: process.env.DSH_HOME ?? join(homedir(), '.dsh-learn') }
const clientOnlyLibraries = new Set(discoverLibraryDirs(root))
const STOP_GRACE_MS = 6_000
const DEBOUNCE_MS = 400

const log = (message: string): void => { console.log(`\x1b[36m[develop]\x1b[0m ${message}`) }

let stopping = false
let server: ResultPromise | undefined
const watchers: ResultPromise[] = []
// execa subprocesses expose no settled `exitCode`; record exits explicitly.
const exited = new WeakSet<ResultPromise>()

function track(child: ResultPromise): ResultPromise {
  void child.then(() => { exited.add(child) })
  return child
}

async function stopChild(child: ResultPromise | undefined): Promise<void> {
  if (child === undefined || exited.has(child)) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => { child.kill('SIGKILL') }, STOP_GRACE_MS)
  await child.catch((error: unknown) => error)
  clearTimeout(timer)
}

function startServer(): void {
  const child = track(execa('node', ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', ...forwarded], {
    cwd: root, env, stdio: 'inherit', reject: false,
  }))
  server = child
  void child.then((result) => {
    if (!stopping && server === child) log(`dsh web exited (code ${String(result.exitCode)}); save a file to start it again`)
  })
}

async function restartServer(reason: string): Promise<void> {
  log(`restarting dsh web: ${reason}`)
  const previous = server
  server = undefined
  await stopChild(previous)
  if (!stopping) startServer()
}

/** Classify one changed path; undefined means this loop ignores it. */
function classify(path: string): 'host' | 'cli' | undefined {
  const parts = path.split(sep)
  // Editors write dot-prefixed temporaries beside the real file.
  if (parts.at(-1)?.startsWith('.') === true) return undefined
  if (parts[0] === 'apps' && parts[1] === 'cli' && parts[2] === 'src') return 'cli'
  if (parts[0] !== 'packages' || parts[3] !== 'src') return undefined
  if (parts.includes('client') || parts.includes('node_modules')) return undefined
  if (clientOnlyLibraries.has(parts.slice(0, 3).join('/'))) return undefined
  return 'host'
}

const pending = { host: new Set<string>(), cli: new Set<string>() }
let timer: NodeJS.Timeout | undefined
let running = false

async function flush(): Promise<void> {
  if (running || stopping) return
  running = true
  try {
    while (pending.host.size + pending.cli.size > 0 && !stopping) {
      const host = [...pending.host]
      const cli = [...pending.cli]
      pending.host.clear()
      pending.cli.clear()
      if (host.length > 0) {
        log(`Host source changed (${host.slice(0, 3).join(', ')}${host.length > 3 ? ', …' : ''}); rebuilding Host libraries`)
        const started = Date.now()
        const build = await execa('pnpm', ['exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'host-libraries'], {
          cwd: root, env, all: true, reject: false,
        })
        if (build.exitCode !== 0) {
          console.error(build.all)
          log('\x1b[31mHost build failed; the previous server keeps running. Fix the error and save again.\x1b[0m')
          continue
        }
        log(`Host libraries rebuilt in ${String(Math.round((Date.now() - started) / 1000))}s`)
      }
      await restartServer(host.length > 0 ? 'Host libraries rebuilt' : `CLI source changed (${cli[0] ?? ''})`)
    }
  } finally {
    running = false
  }
}

async function main(): Promise<void> {
  log(`DSH_HOME=${env.DSH_HOME}`)
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
    log('no build output yet; running build:artifacts once')
    const build = await execa('pnpm', ['run', 'build:artifacts'], { cwd: root, env, stdio: 'inherit', reject: false })
    if (build.exitCode !== 0) process.exit(1)
  }

  const clientWatch = track(execa('pnpm', ['run', 'dev:web', '--skip-build', '--no-serve'], {
    cwd: root, env, stdio: 'inherit', reject: false,
  }))
  watchers.push(clientWatch)
  void clientWatch.then((result) => {
    if (stopping) return
    log(`client watchers exited (code ${String(result.exitCode)}); stopping`)
    void shutdown(1)
  })

  startServer()

  for (const dir of ['packages', 'apps/cli/src']) {
    watch(join(root, dir), { recursive: true }, (_event, file) => {
      if (file === null) return
      const path = relative(root, join(root, dir, file.toString()))
      const kind = classify(path)
      if (kind === undefined) return
      pending[kind].add(path)
      clearTimeout(timer)
      timer = setTimeout(() => { void flush() }, DEBOUNCE_MS)
    })
  }
  log('watching Host sources; client sources are handled by dev:web watchers')
}

async function shutdown(code: number): Promise<void> {
  if (stopping) return
  stopping = true
  clearTimeout(timer)
  await Promise.all([stopChild(server), ...watchers.map(stopChild)])
  process.exit(code)
}

process.on('SIGINT', () => { void shutdown(130) })
process.on('SIGTERM', () => { void shutdown(0) })
await main()
