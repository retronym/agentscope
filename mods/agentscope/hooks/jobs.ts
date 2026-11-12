// bgrun's state files, read as the band shows them. Pure: the hooks module does the reading.
import type { Job } from '../types'

/** A job's state file, as bin/bgrun writes it. */
export type Raw = {
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

export const SHOW_ENDED_S = 30 * 60
// bgrun rewrites a running job's file at least every 10 s; silent for longer, its supervisor is gone
export const BEAT_S = 45
const SILENT_S = 120 // as `bgrun status` does

export const dur = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    : s >= 60
      ? `${Math.floor(s / 60)}m`
      : `${Math.max(0, Math.round(s))}s`

const isOpen = (j: Raw) => j.exit === null || j.exit === undefined

/** When the job stopped: its recorded end, or for a lost one the moment its heartbeat was overdue. */
export const endedAt = (j: Raw, now: number): number | undefined => {
  if (!isOpen(j)) {
    return j.end ?? j.updated ?? j.start
  }

  const overdue = (j.updated ?? j.start) + BEAT_S

  return overdue <= now ? overdue : undefined
}

const outcome = (j: Raw) => (isOpen(j) ? 'lost, no exit recorded,' : `exit ${j.exit}`)

export const view = (j: Raw, now: number): Job => {
  const end = endedAt(j, now)
  const state = end === undefined ? 'running' : isOpen(j) ? 'lost' : j.exit === 0 ? 'done' : 'failed'
  const quiet = now - (j.last_output ?? j.start)
  const head =
    end === undefined
      ? dur(now - j.start) + (quiet > SILENT_S ? `, silent ${dur(quiet)}` : '')
      : `${outcome(j)} after ${dur((j.end ?? j.updated ?? j.start) - j.start)}, ${dur(now - end)} ago`

  return { id: j.id, label: j.label ?? j.id, state, head, last: (j.progress ?? j.last_line ?? '').slice(0, 160) }
}

/** What to say, once, when a job has ended. */
export const farewell = (j: Raw) => {
  const last = (j.progress ?? j.last_line ?? '').slice(0, 120)
  const ran = dur((j.end ?? j.updated ?? j.start) - j.start)
  const how = isOpen(j) ? 'lost (no exit recorded)' : j.exit === 0 ? 'finished' : `failed, exit ${j.exit},`

  return `${j.label ?? j.id} ${how} after ${ran}${last ? `: ${last}` : ''}`
}
