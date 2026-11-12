import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A made-up clone of acme-dev/widgets on branch side/widgets-1.
const HOME = '/home/dev'
const META = `${HOME}/Library/Application Support/Claude/claude-code-sessions/acct/org/local_1.json`
const TURN = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

type Repo = { status: string; remoteRef: boolean; ahead: number; prs: unknown; spawned: boolean }

const world = (on: On, repo: Repo) => {
  const written: string[][] = []
  mock.env(on, { HOME, CLAUDE_CODE_ACCOUNT_UUID: 'acct', CLAUDE_CODE_ORGANIZATION_UUID: 'org', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' })
  on('session.cwd', () => ({ value: '/work/widgets' }))
  on('fs.exists', (_, e) => ({ value: e.path === META }))
  on('fs.read', () => ({ value: JSON.stringify({ spawnedFrom: repo.spawned ? { sessionId: 'local_parent' } : null }) }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', (_, e) => {
    const line = e.argv.join(' ').replace(/^git -C \S+ /, '')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

    if (e.argv[0] === '/bin/sh') {
      written.push(e.argv.slice(4))

      return out('')
    }

    if (line.startsWith('gh pr list')) {
      return repo.prs === undefined ? out('', 1) : out(JSON.stringify(repo.prs))
    }

    return (
      {
        'rev-parse --abbrev-ref HEAD': out('side/widgets-1\n'),
        'remote get-url origin': out('git@github.com:acme-dev/widgets.git\n'),
        'rev-parse --short HEAD': out('abc1234\n'),
        'status --porcelain': out(repo.status),
        'rev-parse --verify -q refs/remotes/origin/side/widgets-1': repo.remoteRef ? out('abc1234ffff\n') : out('', 1),
        'rev-list --count origin/side/widgets-1..HEAD': out(`${repo.ahead}\n`),
      }[line] ?? out('', 1)
    )
  })

  return written
}

test('a spawned session’s turn ends with one line of facts, written once per change', async ($, on) => {
  const repo: Repo = { status: ' M a.scala\n?? b.scala\n', remoteRef: false, ahead: 0, prs: [], spawned: true }
  const written = world(on, repo)
  await $.turn.complete(TURN)
  await $.turn.complete(TURN) // nothing changed: no second line

  expect(written).toEqual([
    [
      'acme-dev/widgets · side/widgets-1 · local only (abc1234) · PR none · unverified: 2 uncommitted files (written by the agentscope mod from git and gh)',
      'side-widgets-1',
    ],
  ])

  Object.assign(repo, {
    status: '',
    remoteRef: true,
    ahead: 2,
    prs: [{ url: 'https://example.invalid/pull/7', state: 'OPEN', isDraft: true, statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] }],
  })
  await $.turn.complete(TURN)
  expect(written[1]?.[0]).toBe(
    'acme-dev/widgets · side/widgets-1 · pushed, but 2 commits are local only (abc1234) · https://example.invalid/pull/7 (DRAFT) · unverified: 2 unpushed commits, CI failing (written by the agentscope mod from git and gh)',
  )

  Object.assign(repo, { ahead: 0, prs: undefined }) // gh not answering
  await $.turn.complete(TURN)
  expect(written[2]?.[0]).toContain('· pushed (origin/side/widgets-1 @ abc1234) · PR unknown (gh did not answer) · unverified: nothing git or gh can see')
})

test('a session the user started writes nothing', async ($, on) => {
  const written = world(on, { status: '', remoteRef: false, ahead: 0, prs: [], spawned: false })
  await $.turn.complete(TURN)
  expect(written).toEqual([])
})

test('an aborted turn and a subagent’s turn write nothing', async ($, on) => {
  const written = world(on, { status: '', remoteRef: false, ahead: 0, prs: [], spawned: true })
  await $.turn.complete({ ...TURN, isAborted: true, reason: 'aborted' })
  await $.turn.complete({ ...TURN, agentId: 'a1' })
  expect(written).toEqual([])
})

test('the handoff line can be turned off', { options: { handoffLine: false } }, async ($, on) => {
  const written = world(on, { status: '', remoteRef: false, ahead: 0, prs: [], spawned: true })
  await $.turn.complete(TURN)
  expect(written).toEqual([])
})
