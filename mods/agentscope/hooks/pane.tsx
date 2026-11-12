// A pane beside the chat: this session as agentscope sees it. Opened by /agentscope, never by itself. While a surface
// shows the pane, bin/session_view.py asks agentscope every 10 s; closed or hidden, nothing is asked.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderChildren } from 'claude-code'

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

// agentscope's own colours for the machine's buckets (index.html, --s1 to --s4): they read on a light and a dark pane
const BUCKET: Record<string, string> = { agents: '#2a78d6', 'Claude app': '#eb6834', 'system / security': '#1baf7a', other: '#eda100' }
const MARK = { running: '▶', done: '✓', failed: '✗', lost: '?' } as const
const JOB_COLOR = { running: 'claude', done: 'success', failed: 'error', lost: 'warning' } as const
const statusColor = (status: string) => (status.startsWith('waiting') ? 'warning' : status === 'idle' ? 'subtle' : 'claude')
const prColor = (state: string) => (state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'error' : state === 'DRAFT' ? 'subtle' : 'success')
const ciColor = (ci: string) => (/FAIL|ERROR/.test(ci) ? 'error' : /SUCCESS|PASS/.test(ci) ? 'success' : 'warning')

/** The machine's cores in use as one stacked bar, a bucket per colour, the rest of the bar the idle cores. */
export const machineBar = (parts: [string, number][], ncpu: number) => {
  const [w, h] = [400, 8]
  let x = 0
  const rects = parts.map(([name, n]) => {
    const width = (Math.min(n, ncpu) / ncpu) * w
    const rect = `<rect x="${x.toFixed(1)}" width="${width.toFixed(1)}" height="${h}" fill="${BUCKET[name] ?? '#73726c'}"/>`
    x += width

    return rect
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><clipPath id="r"><rect width="${w}" height="${h}" rx="4"/></clipPath><g clip-path="url(#r)"><rect width="${w}" height="${h}" fill="#808080" fill-opacity="0.22"/>${rects.join('')}</g></svg>`
}

/** `dashboard` is where agentscope's page is served; the pane links to this session's drawer there. */
export const pane = (on: On, dashboard = 'https://agentscope.localhost') => {
  const drawer = (sid: string) => `${dashboard.replace(/\/+$/, '')}/#session=${encodeURIComponent(sid)}`

  on('command.run', { command: 'agentscope' }, async $ => {
    const [opened, v] = await openPane($)

    if (opened.isPlaced) {
      return { text: 'agentscope pane opened.' }
    }

    // nowhere to draw it (no surface, or too narrow): say it here instead
    return { text: `${asText(v, await read($, jobs))}\n${drawer(await $.session.id())}\n(The pane is not shown: ${opened.reason}.)` }
  })

  // agentscope's look with what a pane has: a title and stat tiles, a bordered card per section with a small-caps
  // heading, status in colour, tabular numbers, and the machine's cores as a stacked bar where the surface draws SVG.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Link, Text } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const v = await read($, view)
    const list = await read($, jobs)
    const open = await read($, log)
    const href = drawer(await $.session.id())
    const age = v?.ok ? Math.max(0, Math.round((await $.clock.now()) / 1000 - v.at)) : undefined

    const card = (head: string, body: RenderChildren, note?: string) => (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" borderDimColor paddingX={1}>
        <Box gap={1}>
          <Text size="caption" weight="semibold" color="subtle">
            {head.toUpperCase()}
          </Text>
          {note !== undefined && (
            <Text size="caption" dimColor>
              {note}
            </Text>
          )}
        </Box>
        {body}
      </Box>
    )
    const tile = (value: string, label: string) => (
      <Box flexDirection="column" minWidth={10}>
        <Text size="heading" weight="semibold" tabular>
          {value}
        </Text>
        <Text size="caption" dimColor>
          {label}
        </Text>
      </Box>
    )
    const procRows = (procs: Proc[]) =>
      procs.map(p => (
        <Box gap={1}>
          <Text mono tabular>
            {cores(p.cores).padStart(10)}
          </Text>
          <Text mono tabular dimColor>
            {gb(p.rss).padStart(7)}
          </Text>
          <Text wrap="truncate-end">{p.label}</Text>
          <Text dimColor>{`pid ${p.pid}`}</Text>
        </Box>
      ))
    const peerRows = (peers: Peer[]) =>
      peers.map(p => (
        <Box gap={1}>
          <Text color={statusColor(p.status)}>●</Text>
          <Text mono tabular>
            {cores(p.cores).padStart(10)}
          </Text>
          <Text dimColor>{`${p.status}${p.top ? `, ${p.top}` : ''}`}</Text>
          <Text wrap="truncate-end">{cut(p.title, 60)}</Text>
          <Text dimColor>{p.sid}</Text>
        </Box>
      ))
    const footer = (
      <Box gap={2} alignItems="center">
        <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
        <Text size="caption" dimColor>
          {age === undefined ? '' : `as of ${age}s ago, asked every ${POLL_MS / 1000}s while shown`}
        </Text>
      </Box>
    )
    const jobsCard =
      list.length > 0 &&
      card(
        'Jobs (bgrun)',
        <Box flexDirection="column">
          {list.map(j => (
            <Box gap={1}>
              <Text color={JOB_COLOR[j.state]}>{MARK[j.state]}</Text>
              <Text weight="semibold">{j.label}</Text>
              <Text dimColor>{j.head}</Text>
              <Text mono dimColor wrap="truncate-end">
                {cut(j.last, 60)}
              </Text>
            </Box>
          ))}
          <Box gap={1} alignItems="center">
            <Text size="caption" dimColor>
              Log:
            </Text>
            {list.map(j => (
              <Button
                key={`log-${j.id}`}
                label={open?.id === j.id ? `hide ${j.label}` : j.label}
                onPress={() => (open?.id === j.id ? update($, log, () => null) : tail($, j.id))}
              />
            ))}
          </Box>
          {open && (
            <Text size="caption" dimColor>
              {`last ${LOG_LINES} lines of ${open.id}.log`}
            </Text>
          )}
          {open?.lines.map(l => (
            <Text mono wrap="wrap">
              {l}
            </Text>
          ))}
        </Box>,
        String(list.length),
      )

    if (!v?.ok) {
      const [first] = sections(v, list)

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text weight="semibold" color={v ? 'error' : undefined}>
              {first?.head}
            </Text>
            {first?.rows.map(r => <Text wrap="wrap">{r}</Text>)}
          </Box>
          {jobsCard}
          <Link href={href} label="Open in agentscope ↗" />
          {footer}
        </Box>
      )
    }

    const machine = Object.entries(v.machine)
      .filter(([, n]) => n >= 0.05)
      .sort(([, a], [, b]) => b - a)
    const used = machine.reduce((sum, [, n]) => sum + n, 0)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text size="heading" weight="semibold" wrap="truncate-end">
            {v.title ?? 'This session'}
          </Text>
          <Box gap={1}>
            <Text color={statusColor(v.status)}>●</Text>
            <Text dimColor>{v.status}</Text>
            <Link href={href} label="Open in agentscope ↗" />
          </Box>
        </Box>
        <Box gap={2}>
          {tile(v.cores.toFixed(v.cores >= 10 ? 0 : v.cores >= 1 ? 1 : 2), 'cores')}
          {tile(gb(v.rss), 'memory')}
          {tile(v.others_cores.toFixed(1), 'cores, other sessions')}
        </Box>
        {card('Processes', v.procs.length > 0 ? procRows(v.procs) : <Text dimColor>none attributed</Text>)}
        {v.jvms.length > 0 && card('JVMs', procRows(v.jvms), String(v.jvms.length))}
        {jobsCard}
        {v.prs.length > 0 &&
          card(
            'PRs',
            v.prs.map(p => (
              <Box gap={1}>
                {p.url ? <Link href={p.url} label={p.key} /> : <Text>{p.key}</Text>}
                <Text color={prColor(p.state)}>{p.state.toLowerCase()}</Text>
                {p.ci && <Text color={ciColor(p.ci)}>{`CI ${p.ci.toLowerCase()}`}</Text>}
                {p.review && <Text dimColor>{p.review}</Text>}
                <Text wrap="truncate-end">{cut(p.title, 50)}</Text>
              </Box>
            )),
          )}
        {(v.parent || v.spawned.length > 0) &&
          card(
            'Session family',
            <Box flexDirection="column">
              {v.parent && (
                <Box gap={1}>
                  <Text dimColor>↑</Text>
                  <Text color={statusColor(v.parent.status)}>●</Text>
                  <Text wrap="truncate-end">{cut(v.parent.title, 60)}</Text>
                  <Text dimColor>{`${v.parent.status}, ${v.parent.sid}`}</Text>
                </Box>
              )}
              {peerRows(v.spawned)}
            </Box>,
          )}
        {card(
          'Other sessions using CPU',
          v.others.length > 0 ? peerRows(v.others) : <Text dimColor>none over 0.1 cores</Text>,
          v.others.length > 0 ? cores(v.others_cores) : undefined,
        )}
        {card(
          'Machine',
          <Box flexDirection="column">
            {Svg && <Svg source={machineBar(machine, v.ncpu)} alt={`${used.toFixed(1)} of ${v.ncpu} cores in use`} />}
            <Box flexDirection="column">
              {machine.map(([name, n]) => (
                <Box gap={1}>
                  <Text color={BUCKET[name] ?? 'subtle'}>■</Text>
                  <Text mono tabular>
                    {n.toFixed(1).padStart(5)}
                  </Text>
                  <Text>{name}</Text>
                </Box>
              ))}
            </Box>
          </Box>,
          `${used.toFixed(1)} of ${v.ncpu} cores, ${gb(v.mem_total)}`,
        )}
        {footer}
      </Box>
    )
  })
}
