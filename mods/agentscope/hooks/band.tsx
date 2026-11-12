// This session's bgrun jobs in a band above the prompt. bin/bgrun keeps a state file per job; the band shows each
// running job with its age and last line, and a toast says when one ends, so nobody has to ask "progress?".
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Job } from '../types'
import { endedAt, farewell, SHOW_ENDED_S, view } from './jobs'
import type { Raw } from './jobs'
import { openPane } from './pane'

const jobs = atom({ plugin: 'agentscope', key: 'jobs' } as const, [], { shape: 'jobs-1' })
const announced = atom({ plugin: 'agentscope', key: 'announced' } as const, [], { shape: 'announced-1' })

const TICK_MS = 5000
const ANNOUNCE_S = 60 // an end older than this when first seen (a session resumed, the mod just installed) is not news

async function jobsDir($: EngineInterface) { return `${await $.env.get('HOME')}/.cache/agentscope/jobs/${await $.session.id()}`
}

/** This session's jobs worth showing: the running ones, and those that ended in the last half hour. */
async function readJobs($: EngineInterface, now: number): Promise<Raw[]> {
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

async function trace($: EngineInterface, band: Job[]) {
  const dir = `${await $.env.get('HOME')}/.cache/agentscope/mod-trace`
  const text = JSON.stringify({ session: await $.session.id(), surfaces: await $.session.surfaces(), ...seen, last: undefined, band }, null, 1)

  if (text !== seen.last && (await $.fs.exists(dir))) {
    seen.last = text
    await $.fs.write(`${dir}/${await $.session.id()}.json`, text)
  }
}

async function tick($: EngineInterface) {
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

/** Reads the jobs now and every 5 s from here on. */
export function watchJobs($: EngineInterface) {
  const safely = () => void tick($).catch(() => undefined)
  safely()
  $.clock.every(TICK_MS, safely)
}

const OPEN = 'agentscope ›'

/** With `withPane` (the session pane is on) the band's first row ends in a button that opens it. */
export const band = (on: On, withPane = false) => {
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
    const { Box, Button, Text } = $.ui.resolve(e)
    const mark = { running: '▶', done: '✓', failed: '✗', lost: '?' } as const
    const color = { running: undefined, done: 'success', failed: 'error', lost: 'warning' } as const

    return (
      <Box flexDirection="column">
        {list.map((j, i) => (
          <Box>
            <Text color={color[j.state]}>
              {mark[j.state]} {j.label}{' '}
            </Text>
            <Text dimColor>{`${j.head}${j.last ? `  ${j.last}` : ''}`.slice(0, Math.max(20, e.props.bodyColumns - j.label.length - 3 - (withPane && i === 0 ? OPEN.length + 4 : 0)))}</Text>
            {withPane && i === 0 && (
              <Box flexGrow={1} justifyContent="flex-end">
                <Button key="open-pane" label={OPEN} onPress={() => void openPane($).catch(() => undefined)} />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
