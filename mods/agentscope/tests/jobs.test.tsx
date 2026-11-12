import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Made-up jobs of a made-up session, as bin/bgrun writes them.
const HOME = '/home/dev'
const SID = '00000000-aaaa-bbbb-cccc-000000000001'
const DIR = `${HOME}/.cache/agentscope/jobs/${SID}`
const T0 = 1_800_000_000 // seconds

const BAND = {
  plugin: 'agentscope',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type File = Record<string, unknown> & { id: string }

/** A world with the job files given; `files` may be changed between ticks. Returns the toasts shown. */
const world = (on: On, files: File[], sid = SID) => {
  const toasts: string[] = []
  const clock = mock.clock(on, { now: T0 * 1000 })
  mock.env(on, { HOME })
  on('session.id', () => ({ value: sid }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: e.path === DIR }))
  on('fs.list', (_, e) => ({
    value:
      e.path === DIR
        ? files.map(f => ({
            name: `${f.id}.json`,
            kind: 'file' as const,
            size: 1,
            mtimeMs: Number(f.updated ?? f.start) * 1000,
            isLink: false,
          }))
        : [],
  }))
  on('fs.read', (_, e) => {
    const file = files.find(f => e.path === `${DIR}/${f.id}.json`)

    return { value: file ? JSON.stringify(file) : '{ half a fi' }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { clock, toasts }
}

const lines = async ($: Engine, surface: 'terminal' | 'desktop') => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()

  return texts
}

test('a running job shows its age and last line; a long-quiet one says so', async ($, on) => {
  const { clock } = world(on, [
    { id: '0101-120000-build', label: 'build', start: T0 - 190, updated: T0 - 2, last_output: T0 - 3, last_line: `[info] compiling 12 sources ${'x'.repeat(200)}`, exit: null },
    { id: '0101-110000-soak', label: 'soak', start: T0 - 3700, updated: T0 - 5, last_output: T0 - 400, last_line: 'iteration 7', progress: '7/20', exit: null },
  ])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await lines($, surface)).toEqual([
      '▶ build ',
      `3m  [info] compiling 12 sources ${'x'.repeat(24)}`,
      '▶ soak ',
      '1h01m, silent 6m  7/20',
    ])
  }
})

test('a job that ends is toasted once, stays 30 minutes, then leaves', async ($, on) => {
  const job: File = { id: '0101-120000-partest', label: 'partest', start: T0 - 600, updated: T0, last_output: T0, last_line: 'testing', exit: null }
  const { clock, toasts } = world(on, [job])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(toasts).toEqual([])

  Object.assign(job, { exit: 1, end: T0 + 3, updated: T0 + 3, last_line: '3 tests failed' })
  await clock.advance(5000)
  expect(toasts).toEqual(['partest failed, exit 1, after 10m: 3 tests failed'])
  expect(await lines($, 'desktop')).toEqual(['✗ partest ', 'exit 1 after 10m, 2s ago  3 tests failed'])

  await clock.advance(20 * 60 * 1000)
  expect(toasts.length).toBe(1)
  expect((await lines($, 'desktop'))[1]).toBe('exit 1 after 10m, 20m ago  3 tests failed')

  await clock.advance(11 * 60 * 1000)
  expect(await lines($, 'desktop')).toEqual([])
})

test('a reload does not repeat the toast, and old ends are not news', async ($, on) => {
  const { clock, toasts } = world(on, [
    { id: '0101-115900-quick', label: 'quick', start: T0 - 30, updated: T0 - 10, end: T0 - 10, exit: 0, last_line: 'ok' },
    { id: '0101-100000-old', label: 'old', start: T0 - 900, updated: T0 - 600, end: T0 - 600, exit: 2, last_line: 'boom' },
  ])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(toasts).toEqual(['quick finished after 20s: ok'])

  // a reload runs session.start again; $.state stays
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(toasts.length).toBe(1)
  expect((await lines($, 'desktop')).filter(t => /^[✓✗]/.test(t))).toEqual(['✓ quick ', '✗ old '])
})

test('a job whose supervisor stopped writing is shown as lost', async ($, on) => {
  const { clock, toasts } = world(on, [{ id: '0101-120000-gone', label: 'gone', start: T0 - 100, updated: T0 - 20, last_line: 'working', exit: null }])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect((await lines($, 'desktop'))[0]).toBe('▶ gone ')

  await clock.advance(30_000)
  expect(await lines($, 'desktop')).toEqual(['? gone ', 'lost, no exit recorded, after 1m, 5s ago  working'])
  expect(toasts).toEqual(['gone lost (no exit recorded) after 1m: working'])
})

test('another session’s jobs, a half-written file and no jobs folder leave the band to the engine', async ($, on) => {
  const { clock } = world(on, [{ id: '0101-120000-theirs', start: T0 - 5, updated: T0, exit: null }], 'some-other-session')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(await lines($, 'desktop')).toEqual([])
})

test('the first row has a button that opens the session pane', async ($, on) => {
  const opened: string[] = []
  const { clock } = world(on, [{ id: '0101-120000-build', label: 'build', start: T0 - 60, updated: T0, last_output: T0, last_line: 'compiling', exit: null }])
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"ok":false,"error":"not running"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'open-pane' })
  await clock.settle()
  await ui.unmount()

  expect(opened).toEqual(['agentscope'])
})
