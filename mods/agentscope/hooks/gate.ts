// Whether the machine is quiet. A timing run started while sibling sessions are compiling measures them, not the
// change. Before a benchmark command runs, ask agentscope who is using CPU and refuse, naming the sessions.
import type { On } from 'claude-code'

// Commands whose numbers are only worth having on a quiet machine.
const BENCH = /\bperflab\s+(run|ab)\b|\bjmh:run\b|\bJmh\/run\b|-jar\s+\S*(jmh|benchmarks)\S*\.jar\b/
const OVERRIDE = /\bLOAD_GATE=off\b/ // `LOAD_GATE=off perflab run ...` runs anyway
const QUIET_CORES = 1.0 // other sessions' CPU, averaged over the window, above which a run is refused
const WINDOW_MIN = 2
export const gate = (on: On) => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!BENCH.test(e.command) || OVERRIDE.test(e.command)) {
      return next(e)
    }

    const home = (await $.env.get('AGENTSCOPE_HOME')) ?? `${await $.env.get('HOME')}/code/agentscope`
    const ran = await $.process.run(['python3', '-m', 'insights.wholoads', '--json', '--since', String(WINDOW_MIN)], {
      cwd: home,
      timeoutMs: 20000,
    })
    const load = JSON.parse(ran.stdout) as {
      stale_s: number | null
      sessions: { sid: string; title: string; cores: number; procs: { label: string }[] }[]
    }

    // agentscope not sampling: nothing to judge by, so do not stand in the way
    if (load.stale_s === null || load.stale_s > 180) {
      return next(e)
    }

    const me = await $.session.id()
    const others = load.sessions.filter(s => s.sid !== me && s.cores >= 0.1)
    const cores = others.reduce((sum, s) => sum + s.cores, 0)

    if (cores < QUIET_CORES) {
      return next(e)
    }

    const who = others
      .slice(0, 4)
      .map(s => `${s.cores.toFixed(1)} cores: "${s.title}" (${s.sid.slice(0, 8)}${s.procs[0] ? `, ${s.procs[0].label}` : ''})`)
      .join('; ')
    $.ui.toast(`Benchmark held: other sessions are using ${cores.toFixed(1)} cores`, { timeoutMs: 10000 })

    return {
      deny:
        `agentscope load gate: not started. Other sessions used ${cores.toFixed(1)} cores over the last ${WINDOW_MIN} min, ` +
        `so the timings would measure them. ${who}. Wait for them (python3 -m insights.wholoads in ~/code/agentscope exits 0 when quiet), ` +
        `ask Jason whether to pause them, or prefix the command with LOAD_GATE=off if the numbers do not matter. Do not stop another session's processes.`,
    }
    // a gate that cannot judge (agentscope missing, bad JSON) lets the command through
  }).catch(($, e, next) => next(e))
}
