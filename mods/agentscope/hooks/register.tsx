// Two things an agent session cannot see for itself, taken from agentscope:
//
// 1. Its long-running commands. bin/bgrun keeps a state file per job; a band above the prompt shows each running job
//    with its age and last line, and says when one ends, so nobody has to ask "progress?".
// 2. Whether the machine is quiet. A timing run started while sibling sessions are compiling measures them, not the
//    change. Before a benchmark command runs, ask agentscope who is using CPU and refuse, naming the sessions.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Job } from '../types'

const jobs = atom({ plugin: 'agentscope', key: 'jobs' } as const, [], { shape: 'jobs-1' })

// Commands whose numbers are only worth having on a quiet machine.
const BENCH = /\bperflab\s+(run|ab)\b|\bjmh:run\b|\bJmh\/run\b|-jar\s+\S*(jmh|benchmarks)\S*\.jar\b/
const OVERRIDE = /\bLOAD_GATE=off\b/ // `LOAD_GATE=off perflab run ...` runs anyway
const QUIET_CORES = 1.0 // other sessions' CPU, averaged over the window, above which a run is refused
const WINDOW_MIN = 2
const SHOW_ENDED_S = 30 * 60
const BEAT_S = 45 // bgrun rewrites a running job's file at least every 10 s; silent for longer, its supervisor is gone

const dur = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${Math.round(s)}s`

type Raw = {
  id: string
  label?: string
  start: number
  updated?: number
  end?: number | null
  exit?: number | null
  last_line?: string
  progress?: string
  last_output?: number | null
}

const describe = (j: Raw, now: number): Job => {
  const isOpen = j.exit === null || j.exit === undefined
  const state = !isOpen ? (j.exit === 0 ? 'done' : 'failed') : now - (j.updated ?? j.start) < BEAT_S ? 'running' : 'lost'
  const quiet = now - (j.last_output ?? j.start)
  const head =
    state === 'running'
      ? dur(now - j.start) + (quiet > 300 ? `, silent ${dur(quiet)}` : '')
      : state === 'lost'
        ? 'lost: no exit recorded'
        : `exit ${j.exit} after ${dur((j.end ?? now) - j.start)}, ${dur(now - (j.end ?? now))} ago`

  return { id: j.id, label: j.label ?? j.id, state, head, last: (j.progress ?? j.last_line ?? '').slice(0, 160) }
}

export const register: Register = on => {
  // What each job was last seen doing, to say so once when it ends. Lost on a reload, hence `isPrimed`.
  const seen = new Map<string, Job['state']>()
  let isPrimed = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    const tick = async () => {
      const dir = `${await $.env.get('HOME')}/.cache/agentscope/jobs/${await $.session.id()}`
      const now = (await $.clock.now()) / 1000
      const list: Job[] = []

      if (await $.fs.exists(dir)) {
        const files = (await $.fs.list(dir)).filter(f => f.name.endsWith('.json') && now - f.mtimeMs / 1000 < 86400)

        for (const f of files) {
          try {
            const raw = JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as Raw
            const job = describe(raw, now)
            const before = seen.get(job.id)
            seen.set(job.id, job.state)

            if (isPrimed && job.state !== 'running' && before !== job.state) {
              $.ui.toast(`${job.label}: ${job.head.replace(/, \S+ ago$/, '')}`, { timeoutMs: 15000 })
            }

            if (job.state === 'running' || now - (raw.end ?? raw.updated ?? raw.start) < SHOW_ENDED_S) {
              list.push(job)
            }
          } catch {
            // a file caught mid-rename, or not a job: the next tick reads it again
          }
        }
      }

      isPrimed = true
      list.sort((a, b) => Number(a.state !== 'running') - Number(b.state !== 'running') || b.id.localeCompare(a.id))
      const shown = list.slice(0, 4)

      // write only on a change: every write redraws the band
      if (JSON.stringify(shown) !== JSON.stringify(await read($, jobs))) {
        await update($, jobs, () => shown)
      }
    }

    const safely = () => void tick().catch(() => undefined)
    safely()
    $.clock.every(5000, safely)

    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, jobs)

    if (e.props.hasSurvey || list.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const mark = { running: '▶', done: '✓', failed: '✗', lost: '?' } as const
    const color = { running: undefined, done: 'success', failed: 'error', lost: 'warning' } as const

    return (
      <Box flexDirection="column">
        {list.map(j => (
          <Box>
            <Text color={color[j.state]}>
              {mark[j.state]} {j.label}{' '}
            </Text>
            <Text dimColor>
              {j.head}
              {j.last ? `  ${j.last}` : ''}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })

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
