import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { machineBar } from '../hooks/pane'

const RUN = { command: 'agentscope', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

// A made-up session, as bin/session_view.py would print it.
const VIEW = {
  ok: true,
  at: 1_800_000_000,
  ncpu: 10,
  mem_total: 32 * 2 ** 30,
  title: 'widget refactor',
  status: 'busy',
  cores: 1.5,
  rss: 3 * 2 ** 30,
  procs: [{ label: 'sbt server', pid: 11, cores: 1.3, rss: 2 * 2 ** 30 }],
  jvms: [{ label: 'sbt server', pid: 11, cores: 1.3, rss: 2 * 2 ** 30 }],
  prs: [{ key: 'acme/widgets#7', title: 'Faster widgets', url: 'https://example.invalid/7', state: 'DRAFT', ci: 'FAILURE', review: null }],
  parent: { sid: 'parent00', title: 'widget planning', status: 'idle', cores: 0, top: null },
  spawned: [{ sid: 'child000', title: 'widget benchmarks', status: 'waiting: permission', cores: 0, top: null }],
  others: [{ sid: 'noisy000', title: 'gadget partest', status: 'busy', cores: 4.2, top: 'partest' }],
  others_cores: 4.2,
  machine: { agents: 5.7, other: 0.3, idle: 0.01 },
}

const PANE = {
  plugin: 'agentscope',
  component: 'Pane',
  requestId: 'agentscope',
  props: { title: 'agentscope', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** A world where agentscope answers `answer()` and the pane is, or is not, given a place. */
const world = (on: On, answer: () => string, isPlaced = true, job?: Record<string, unknown>) => {
  const asked: (readonly string[])[] = []
  const clock = mock.clock(on, { now: 1_800_000_004_000 })
  mock.env(on, { HOME: '/home/dev' })
  on('session.id', () => ({ value: 'me000000-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: job !== undefined && e.path.endsWith('/jobs/me000000-1') }))
  on('fs.list', () => ({ value: [{ name: `${String(job?.id)}.json`, kind: 'file' as const, size: 1, mtimeMs: 1_800_000_004_000, isLink: false }] }))
  on('fs.read', () => ({ value: JSON.stringify(job) }))
  on('command.register', () => ({ value: { command: 'agentscope' } }))
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } }))
  on('ui.panes', () => ({ value: [{ id: 'agentscope', title: 'agentscope', isShown: isPlaced, isFocused: false, isPlaced }] }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'tail') {
      return { value: { exitCode: 0, stdout: `[info] compiling\n[info] done ${e.argv[3]}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    asked.push(e.argv)

    return { value: { exitCode: 0, stdout: answer(), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { asked, clock }
}

test('/agentscope opens the pane, which shows the session on every surface', async ($, on) => {
  const { asked } = world(on, () => JSON.stringify(VIEW))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(asked.length).toBe(0) // nothing is asked until the pane is opened

  const ran = await $.command.run(RUN)
  expect(ran.text).toBe('agentscope pane opened.')
  expect(asked[0]?.slice(-2)).toEqual([expect.stringMatching(/\/bin\/session_view\.py$/), 'me000000-1'])

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)

    expect(texts).toEqual([
      'widget refactor',
      '●', 'busy',
      '1.5', 'cores', '3.0 GB', 'memory', '4.2', 'cores, other sessions',
      'PROCESSES',
      ' 1.3 cores', ' 2.0 GB', 'sbt server', 'pid 11',
      'JVMS', '1',
      ' 1.3 cores', ' 2.0 GB', 'sbt server', 'pid 11',
      'PRS',
      'draft', 'CI failure', 'Faster widgets',
      'SESSION FAMILY',
      '↑', '●', 'widget planning', 'idle, parent00',
      '●', '0.00 cores', 'waiting: permission', 'widget benchmarks', 'child000',
      'OTHER SESSIONS USING CPU', '4.2 cores',
      '●', ' 4.2 cores', 'busy, partest', 'gadget partest', 'noisy000',
      'MACHINE', '6.0 of 10 cores, 32.0 GB',
      '■', '  5.7', 'agents',
      '■', '  0.3', 'other',
      'as of 4s ago, asked every 10s while shown',
    ])
    // the session's drawer on the dashboard, and the PR
    expect((await ui.findAll({ type: 'Link' })).map(l => l.text)).toEqual(['Open in agentscope ↗', 'acme/widgets#7'])
    // the machine's bar is drawn where the surface draws SVG; the terminal has the rows alone
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(surface === 'terminal' ? 0 : 1)
    await ui.unmount()
  }
})

test('agentscope is asked every 10 s only while the pane is shown', async ($, on) => {
  const shown = world(on, () => JSON.stringify(VIEW))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await shown.clock.advance(25_000)
  expect(shown.asked.length).toBe(2)
})

test('a pane that is not shown asks nothing', async ($, on) => {
  const hidden = world(on, () => JSON.stringify(VIEW), false)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await hidden.clock.advance(60_000)
  expect(hidden.asked.length).toBe(0)
})

test('when agentscope is down the pane says so, and Refresh asks again', async ($, on) => {
  let answer = JSON.stringify({ ok: false, error: 'agentscope is not answering at http://localhost:8377: Connection refused' })
  const { asked } = world(on, () => answer)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).slice(0, 3)).toEqual([
    'agentscope is not reachable',
    'agentscope is not answering at http://localhost:8377: Connection refused',
    'Its numbers are not shown rather than shown stale.',
  ])

  answer = 'Traceback: not JSON at all'
  await ui.press({ key: 'refresh' })
  expect(asked.length).toBe(2)
  expect((await ui.find({ type: 'Text', text: /could not ask/ }))?.text).toMatch(/^could not ask agentscope: /)
  await ui.unmount()
})

test('with nowhere to draw a pane, /agentscope prints the same text', async ($, on) => {
  world(on, () => JSON.stringify(VIEW), false)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  const ran = await $.command.run(RUN)
  expect(ran.text).toContain('This session (busy): 1.5 cores, 3.0 GB\n   1.3 cores   2.0 GB  sbt server (pid 11)\nJVMs: 1')
  expect(ran.text).toContain('https://agentscope.localhost/#session=me000000-1\n(The pane is not shown: no-surface.)')
})

test('a job’s button shows the end of its log in the pane, and hides it again', async ($, on) => {
  const { clock } = world(on, () => JSON.stringify(VIEW), true, {
    id: '0101-120000-build',
    label: 'build',
    start: 1_800_000_000 - 180,
    updated: 1_800_000_004,
    last_output: 1_800_000_004,
    last_line: 'compiling',
    exit: null,
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'log-0101-120000-build' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('last 40 lines of 0101-120000-build.log')
  expect(texts).toContain('[info] done /home/dev/.cache/agentscope/jobs/me000000-1/0101-120000-build.log')

  await ui.press({ key: 'log-0101-120000-build' })
  expect(await ui.find({ type: 'Text', text: /last 40 lines/ })).toBeUndefined()
  await ui.unmount()
})

test('the machine bar gives each bucket its share of the cores', () => {
  const svg = machineBar([['agents', 5], ['other', 2.5]], 10)
  expect(svg).toContain('<rect x="0.0" width="200.0" height="8" fill="#2a78d6"/>')
  expect(svg).toContain('<rect x="200.0" width="100.0" height="8" fill="#eda100"/>')
})
