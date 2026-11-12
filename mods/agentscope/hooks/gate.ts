// Whether the machine is quiet. A timing run started while sibling sessions are compiling measures them, not the
// change. Before a benchmark command runs, ask agentscope who is using CPU and refuse, naming the sessions.
import type { EngineInterface } from 'claude-code'

import { base, setting } from './shell'
import type { Cmd } from './shell'

const QUIET_CORES = 1.0 // other sessions' CPU, averaged over the window, above which a run is refused
const WINDOW_MIN = 3 // agentscope samples each minute, so a shorter window can hold a single sample

/** A command whose numbers are only worth having on a quiet machine: perflab run / ab, or JMH. */
export const isBenchmark = (cmd: Cmd) => {
  const name = base(cmd.argv[0])
  const args = cmd.argv.slice(1)

  if (args.includes('--help') || args.includes('-h')) {
    return false
  }

  return (
    (name === 'perflab' && (args[0] === 'run' || args[0] === 'ab')) ||
    (/^sbtn?$/.test(name) && /\bjmh\s*[:/]\s*run(Main)?\b/i.test(args.join(' '))) ||
    (name === 'java' && args.some((a, i) => args[i - 1] === '-jar' && /(jmh|benchmarks)[^/]*\.jar$/i.test(a)))
  )
}

type Load = {
  stale_s: number | null
  sessions: { sid: string; title: string; cores: number; procs: { label: string }[] }[]
}

/** Why this command line should not start now, or undefined to let it run. LOAD_GATE=off, or =<cores>, on the command overrides. */
export async function loadGate($: EngineInterface, cmds: Cmd[]): Promise<string | undefined> {
  const bench = cmds.find(isBenchmark)
  const override = bench && setting(bench, 'LOAD_GATE')

  if (!bench || override === 'off') {
    return undefined
  }

  const limit = override !== undefined && Number.isFinite(Number(override)) ? Number(override) : QUIET_CORES
  const home = (await $.env.get('AGENTSCOPE_HOME')) ?? `${await $.env.get('HOME')}/code/agentscope`
  const ran = await $.process.run(['python3', '-m', 'insights.wholoads', '--json', '--since', String(WINDOW_MIN)], {
    cwd: home,
    timeoutMs: 20000,
  })
  // agentscope missing or not answering JSON: this throws, and the caller lets the command through
  const load = JSON.parse(ran.stdout) as Load

  // agentscope not sampling: nothing to judge by, so do not stand in the way
  if (load.stale_s === null || load.stale_s > 180) {
    return undefined
  }

  const me = await $.session.id()
  const others = load.sessions.filter(s => s.sid !== me)
  const cores = others.reduce((sum, s) => sum + s.cores, 0)

  if (cores <= limit) {
    return undefined
  }

  const who = others
    .slice(0, 4)
    .map(s => `${s.cores.toFixed(1)} cores: "${s.title}" (${s.sid.slice(0, 8)}${s.procs[0] ? `, ${s.procs[0].label}` : ''})`)
    .join('; ')
  $.ui.toast(`Benchmark held: other sessions are using ${cores.toFixed(1)} cores`, { timeoutMs: 10000 })

  return (
    `agentscope load gate: not started. Other sessions used ${cores.toFixed(1)} cores over the last ${WINDOW_MIN} min (limit ${limit}), ` +
    `so the timings would measure them. ${who}. Wait for them (python3 -m insights.wholoads in ${home} exits 0 when quiet), ` +
    `ask the user whether to pause them, or prefix the command with LOAD_GATE=off if the numbers do not matter. Do not stop another session's processes.`
  )
}
