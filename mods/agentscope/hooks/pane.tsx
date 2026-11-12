// A pane beside the chat: this session as agentscope sees it. Opened by /agentscope, never by itself. While a surface
// shows the pane, bin/session_view.py asks agentscope every 10 s; closed or hidden, nothing is asked.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Job, Peer, Proc, View } from '../types'

const PANE = 'agentscope'
const TITLE = 'agentscope'
const POLL_MS = 10_000

// the band's jobs, read here too (an atom is named in the file that reads it)
const jobs = atom({ plugin: 'agentscope', key: 'jobs' } as const, [], { shape: 'jobs-1' })
const view = atom({ plugin: 'agentscope', key: 'view' } as const, null, { shape: 'view-1' })

const log = atom({ plugin: 'agentscope', key: 'log' } as const, null, { shape: 'log-1' })
const LOG_LINES = 40

const gb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`)
const cores = (n: number) => `${n.toFixed(n >= 10 ? 0 : n >= 1 ? 1 : 2)} cores`
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

/** Asks agentscope about this session; an answer it cannot get is an answer too. */
async function ask($: EngineInterface): Promise<View> {
  try {
    const url = await $.env.get('AGENTSCOPE_URL')
    const ran = await $.process.run(
      ['python3', `${$.plugin.root}/bin/session_view.py`, await $.session.id(), ...(url ? ['--url', url] : [])],
      { timeoutMs: 15_000 },
    )

    return JSON.parse(ran.stdout) as View
  } catch (error) {
    return { ok: false, error: `could not ask agentscope: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The end of a job's log: bgrun keeps it beside the state file, control characters stripped. */
async function tail($: EngineInterface, id: string) {
  const path = `${await $.env.get('HOME')}/.cache/agentscope/jobs/${await $.session.id()}/${id}.log`
  const ran = await $.process.run(['tail', '-n', String(LOG_LINES), path], { timeoutMs: 5000 })
  const lines = ran.exitCode === 0 ? ran.stdout.replace(/\n$/, '').split('\n') : [`no log at ${path}`]
  await update($, log, () => ({ id, lines }))
}

async function refresh($: EngineInterface) {
  const next = await ask($)
  await update($, view, () => next)
  const open = await read($, log)

  if (open) {
    await tail($, open.id).catch(() => undefined)
  }

  return next
}

const proc = (p: Proc) => `${cores(p.cores).padStart(10)}  ${gb(p.rss).padStart(7)}  ${p.label} (pid ${p.pid})`
// what matters first: a row too long for the pane loses the end of the title
const peer = (p: Peer) => `${cores(p.cores).padStart(10)}  ${p.status}${p.top ? `, ${p.top}` : ''}  ${cut(p.title, 60)} (${p.sid})`
const job = (j: Job) => `${{ running: '▶', done: '✓', failed: '✗', lost: '?' }[j.state]} ${j.label}  ${j.head}${j.last ? `  ${cut(j.last, 60)}` : ''}`

/** The pane as lines of text, a heading per section: what the pane draws, and what /agentscope prints where no pane can be shown. */
export const sections = (v: View | null, list: Job[]): { head: string; rows: string[] }[] => {
  if (v === null) {
    return [{ head: 'Asking agentscope…', rows: [] }]
  }

  if (!v.ok) {
    return [{ head: 'agentscope is not reachable', rows: [v.error, 'Its numbers are not shown rather than shown stale.'] }]
  }

  const machine = Object.entries(v.machine)
    .filter(([, n]) => n >= 0.05)
    .sort(([, a], [, b]) => b - a)
    .map(([name, n]) => `${n.toFixed(1).padStart(5)}  ${name}`)

  return [
    {
      head: `This session (${v.status}): ${cores(v.cores)}, ${gb(v.rss)}`,
      rows: v.procs.length > 0 ? v.procs.map(proc) : ['no processes attributed'],
    },
    { head: `JVMs: ${v.jvms.length || 'none'}`, rows: v.jvms.map(proc) },
    { head: `bgrun jobs: ${list.length || 'none'}`, rows: list.map(job) },
    {
      head: `PRs: ${v.prs.length || 'none'}`,
      rows: v.prs.map(p => `${p.key}  ${p.state}${p.ci ? `, CI ${p.ci}` : ''}${p.review ? `, ${p.review}` : ''}  ${cut(p.title, 50)}`),
    },
    ...(v.parent ? [{ head: `Spawned by (${v.parent.status}, ${v.parent.sid})`, rows: [cut(v.parent.title, 80)] }] : []),
    { head: `Spawned sessions: ${v.spawned.length || 'none'}`, rows: v.spawned.map(peer) },
    {
      head: v.others.length > 0 ? `Other sessions using CPU: ${cores(v.others_cores)}` : 'Other sessions using CPU: none over 0.1 cores',
      rows: v.others.map(peer),
    },
    { head: `Machine (${v.ncpu} cores, ${gb(v.mem_total)}), cores in use`, rows: machine },
  ]
}

const asText = (v: View | null, list: Job[]) =>
  sections(v, list)
    .map(s => [s.head, ...s.rows.map(r => `  ${r}`)].join('\n'))
    .join('\n')

// For checking against a live session with no surface to draw on: while ~/.cache/agentscope/mod-trace/ exists, what
// the pane would show at load is written to <session id>.pane.txt there.
async function traceOnce($: EngineInterface) {
  const dir = `${await $.env.get('HOME')}/.cache/agentscope/mod-trace`

  if (await $.fs.exists(dir)) {
    await $.fs.write(`${dir}/${await $.session.id()}.pane.txt`, asText(await ask($), await read($, jobs)))
  }
}

/** Registers /agentscope and starts the poll, which asks only while a surface shows the pane. */
export async function offerPane($: EngineInterface) {
  await $.command.register({
    name: 'agentscope',
    description: 'Show this session as agentscope sees it: CPU, memory, JVMs, jobs, PRs, spawned sessions',
    immediate: true,
  })

  $.clock.every(POLL_MS, () => {
    void $.ui
      .panes()
      .then(panes => (panes.some(p => p.id === PANE && p.isPlaced && p.isShown) ? refresh($) : undefined))
      .catch(() => undefined)
  })
  void traceOnce($).catch(() => undefined)
}

/** Opens the pane and asks agentscope now. The command and the band's button both come here. */
export async function openPane($: EngineInterface) {
  return Promise.all([$.ui.open({ id: PANE, title: TITLE }), refresh($)])
}

export const pane = (on: On) => {
  on('command.run', { command: 'agentscope' }, async $ => {
    const [opened, v] = await openPane($)

    if (opened.isPlaced) {
      return { text: 'agentscope pane opened.' }
    }

    // nowhere to draw it (no surface, or too narrow): say it here instead
    return { text: `${asText(v, await read($, jobs))}\n(The pane is not shown: ${opened.reason}.)` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const list = await read($, jobs)
    const open = await read($, log)
    const all = sections(v, list)
    const age = v?.ok ? Math.max(0, Math.round((await $.clock.now()) / 1000 - v.at)) : undefined

    return (
      <Box flexDirection="column" gap={1}>
        {all.map(s => (
          <Box flexDirection="column">
            <Text bold color={v?.ok === false ? 'error' : undefined}>
              {s.head}
            </Text>
            {s.rows.map(r => (
              <Text mono wrap="truncate-end">
                {r}
              </Text>
            ))}
          </Box>
        ))}
        {v?.ok && v.prs.some(p => p.url) && (
          <Box flexDirection="column">
            {v.prs.map(p => (p.url ? <Link href={p.url} label={p.key} /> : null))}
          </Box>
        )}
        {list.length > 0 && (
          <Box flexDirection="column">
            <Box gap={1}>
              <Text dimColor>Log:</Text>
              {list.map(j => (
                <Button
                  key={`log-${j.id}`}
                  label={open?.id === j.id ? `hide ${j.label}` : j.label}
                  onPress={() => (open?.id === j.id ? update($, log, () => null) : tail($, j.id))}
                />
              ))}
            </Box>
            {open && <Text dimColor>{`last ${LOG_LINES} lines of ${open.id}.log`}</Text>}
            {open?.lines.map(l => (
              <Text mono wrap="wrap">
                {l}
              </Text>
            ))}
          </Box>
        )}
        <Box gap={2}>
          <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
          <Text dimColor>{age === undefined ? '' : `as of ${age}s ago, asked every ${POLL_MS / 1000}s while shown`}</Text>
        </Box>
      </Box>
    )
  })
}
