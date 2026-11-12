// What an agent session cannot see for itself, taken from agentscope:
//
// 1. Its long-running commands. bin/bgrun keeps a state file per job; a band above the prompt shows each running job
//    with its age and last line, and says when one ends, so nobody has to ask "progress?".
// 2. Whether the machine is quiet. A timing run started while sibling sessions are compiling measures them, not the
//    change. Before a benchmark command runs, ask agentscope who is using CPU and refuse, naming the sessions.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job } from '../types'
import { endedAt, farewell, SHOW_ENDED_S, view } from './jobs'
import type { Raw } from './jobs'

const jobs = atom({ plugin: 'agentscope', key: 'jobs' } as const, [], { shape: 'jobs-1' })
const announced = atom({ plugin: 'agentscope', key: 'announced' } as const, [], { shape: 'announced-1' })

// Commands whose numbers are only worth having on a quiet machine.
const BENCH = /\bperflab\s+(run|ab)\b|\bjmh:run\b|\bJmh\/run\b|-jar\s+\S*(jmh|benchmarks)\S*\.jar\b/
const OVERRIDE = /\bLOAD_GATE=off\b/ // `LOAD_GATE=off perflab run ...` runs anyway
const QUIET_CORES = 1.0 // other sessions' CPU, averaged over the window, above which a run is refused
const WINDOW_MIN = 2
const TICK_MS = 5000
const ANNOUNCE_S = 60 // an end older than this when first seen (a session resumed, the mod just installed) is not news

const jobsDir = async ($: EngineInterface) => `${await $.env.get('HOME')}/.cache/agentscope/jobs/${await $.session.id()}`

/** This session's jobs worth showing: the running ones, and those that ended in the last half hour. */
const readJobs = async ($: EngineInterface, now: number): Promise<Raw[]> => {
  const dir = await jobsDir($)

  if (!(await $.fs.exists(dir))) {
    return []
  }

  // a running job's file is rewritten every 10 s, so an old file is an old job
  const files = (await $.fs.list(dir)).filter(f => f.name.endsWith('.json') && now - f.mtimeMs / 1000 < SHOW_ENDED_S + 60)
  const raws: Raw[] = []

  for (const f of files) {
    try {
      const raw = JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as Raw

      if (typeof raw.id === 'string' && typeof raw.start === 'number') {
        raws.push(raw)
      }
    } catch {
      // a file caught mid-rename, or not a job: the next tick reads it again
    }
  }

  return raws
}

// For checking the mod against a live session: while ~/.cache/agentscope/mod-trace/ exists, each change to what the
// band shows, each toast and the surface that last drew the band are written to <session id>.json there.
const seen = { drawnBy: '', draws: 0, attached: [] as string[], toasts: [] as string[], last: '' }

const trace = async ($: EngineInterface, band: Job[]) => {
  const dir = `${await $.env.get('HOME')}/.cache/agentscope/mod-trace`
  const text = JSON.stringify({ session: await $.session.id(), surfaces: await $.session.surfaces(), ...seen, last: undefined, band }, null, 1)

  if (text !== seen.last && (await $.fs.exists(dir))) {
    seen.last = text
    await $.fs.write(`${dir}/${await $.session.id()}.json`, text)
  }
}

const tick = async ($: EngineInterface) => {
  const now = (await $.clock.now()) / 1000
  const raws = await readJobs($, now)
  const said = await read($, announced)
  const news = raws.filter(j => {
    const end = endedAt(j, now)

    return end !== undefined && now - end < ANNOUNCE_S && !said.includes(j.id)
  })

  if (news.length > 0) {
    await update($, announced, ids => [...ids, ...news.map(j => j.id)].slice(-100))
    news.forEach(j => $.ui.toast(farewell(j), { timeoutMs: 15000 }))
    seen.toasts = [...seen.toasts, ...news.map(farewell)].slice(-20)
  }

  const shown = raws
    .filter(j => now - (endedAt(j, now) ?? now) < SHOW_ENDED_S)
    .map(j => view(j, now))
    .sort((a, b) => Number(a.state !== 'running') - Number(b.state !== 'running') || b.id.localeCompare(a.id))
    .slice(0, 4)

  // write only on a change: every write redraws the band
  if (JSON.stringify(shown) !== JSON.stringify(await read($, jobs))) {
    await update($, jobs, () => shown)
  }

  await trace($, shown)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const safely = () => void tick($).catch(() => undefined)
    safely()
    $.clock.every(TICK_MS, safely)

    return started
  })

  on('session.attach', ($, e, next) => {
    seen.attached = [...seen.attached, e.surface].slice(-10)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, jobs)
    seen.drawnBy = e.surface
    seen.draws += 1

    if (e.props.hasSurvey || list.length === 0) {
      return next(e)
    }

    // one row per job: the last line is cut to the band's width, not wrapped
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
            <Text dimColor>{`${j.head}${j.last ? `  ${j.last}` : ''}`.slice(0, Math.max(20, e.props.bodyColumns - j.label.length - 3))}</Text>
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
