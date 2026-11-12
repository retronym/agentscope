import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// A made-up machine: the user is "acme-dev", the session runs in a clone of acme-dev/widgets whose upstream is bigco/widgets.
const HOME = '/home/dev'
const SID = '00000000-aaaa-bbbb-cccc-000000000001'
const META = `${HOME}/Library/Application Support/Claude/claude-code-sessions/acct/org/local_1.json`
const STARTED = 1_800_000_000_000
const OPTIONS = { ownOwners: 'acme-dev' }

type World = {
  /** Other sessions' load, as insights.wholoads --json prints it; a string is printed as is. */
  load?: unknown
  /** The desktop record of this session; absent, the session is not a desktop one. */
  meta?: Record<string, unknown>
  /** What `gh repo view` answers for the working directory. */
  defaultRepo?: string
  /** Oldest reflog entry per branch, in seconds. */
  reflog?: Record<string, number>
}

/** Returns what reached the engine (`ran`) and every process the mod started (`asked`). */
const world = (on: On, w: World = {}) => {
  const ran: string[] = []
  const asked: string[] = []
  mock.clock(on, { now: STARTED + 3_600_000 })
  mock.env(on, {
    HOME,
    AGENTSCOPE_HOME: '/opt/agentscope',
    ...(w.meta ? { CLAUDE_CODE_ACCOUNT_UUID: 'acct', CLAUDE_CODE_ORGANIZATION_UUID: 'org', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' } : {}),
  })
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: '/work/widgets' }))
  on('fs.exists', (_, e) => ({ value: e.path === META }))
  on('fs.read', () => ({ value: JSON.stringify(w.meta ?? {}) }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')
    const git = line.replace(/^git -C \S+ /, '')
    asked.push(line)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

    if (line.includes('insights.wholoads')) {
      return out(typeof w.load === 'string' ? w.load : JSON.stringify(w.load))
    }

    if (line.startsWith('gh repo view')) {
      return w.defaultRepo ? out(`${w.defaultRepo}\n`) : out('', 1)
    }

    if (git === 'remote get-url --push origin') {
      return out('git@github.com:acme-dev/widgets.git\n')
    }

    if (git === 'remote get-url --push upstream') {
      return out('https://github.com/bigco/widgets\n')
    }

    if (git === 'rev-parse --abbrev-ref HEAD') {
      return out('feature\n')
    }

    const reflog = /^reflog show .* refs\/heads\/(\S+)$/.exec(git)?.[1]

    if (reflog !== undefined) {
      const t = w.reflog?.[reflog]

      return t === undefined ? out('', 128) : out(`${reflog}@{${t + 500}}\n${reflog}@{${t}}\n`)
    }

    return out('', 1)
  })
  on('tool.call', (_, e) => {
    ran.push(String((e as { command?: string }).command))

    return { result: {} }
  })

  return { ran, asked }
}

const bash = async ($: Engine, command: string) => {
  const r = (await $.tool.call({ tool: 'Bash', command })) as { deny?: string; isError?: boolean; text?: string }

  return r.deny ?? (r.isError ? (r.text ?? 'refused') : 'ran')
}

const BUSY = {
  stale_s: 20,
  sessions: [
    { sid: SID, title: 'this one', cores: 3.0, procs: [{ label: 'sbt server' }] },
    { sid: '11111111-x', title: 'gadget partest', cores: 2.4, procs: [{ label: 'partest' }] },
    { sid: '22222222-y', title: 'doc build', cores: 0.3, procs: [] },
  ],
}
const QUIET = { stale_s: 20, sessions: [{ sid: SID, title: 'this one', cores: 6.0, procs: [] }, { sid: '22222222-y', title: 'doc build', cores: 0.3, procs: [] }] }

// --- benchmark load gate

test('a benchmark is refused while other sessions load the machine, naming them', { options: OPTIONS }, async ($, on) => {
  const { ran, asked } = world(on, { load: BUSY })
  const said = await bash($, 'cd /work/bench && perflab run --profile quick')

  expect(said).toContain('agentscope load gate: not started. Other sessions used 2.7 cores over the last 3 min')
  expect(said).toContain('2.4 cores: "gadget partest" (11111111, partest); 0.3 cores: "doc build" (22222222)')
  expect(said).not.toContain('this one') // its own load is not the noise
  expect(ran).toEqual([])
  expect(asked).toEqual(['python3 -m insights.wholoads --json --since 3'])
})

test('every way of starting a benchmark is seen', { options: OPTIONS }, async ($, on) => {
  const { ran } = world(on, { load: BUSY })

  for (const command of [
    'perflab ab --base main --head feature',
    'BGRUN=off sbt "bench/Jmh/run -i 5 MyBench"',
    'sbt bench/jmh:run',
    'time java -jar target/benchmarks.jar -f 1',
    'bgrun --label ab -- perflab ab base head',
    "bgrun --label ab 'cd bench && perflab run'",
    'nohup /opt/tools/bin/perflab run > out.log 2>&1 &',
    'bash -lc "perflab run"',
    'LOAD_GATE=5 FOO=1 perflab run; echo done',
  ]) {
    const said = await bash($, command)
    expect(said.startsWith('agentscope load gate') ? 'held' : `${command} => ${said}`).toBe(command === 'LOAD_GATE=5 FOO=1 perflab run; echo done' ? `${command} => ran` : 'held')
  }

  expect(ran).toEqual(['LOAD_GATE=5 FOO=1 perflab run; echo done']) // a limit of 5 cores lets 2.7 through
})

test('a command that only mentions a benchmark is not one', { options: OPTIONS }, async ($, on) => {
  const { ran, asked } = world(on, { load: BUSY })
  const mentions = [
    'grep -rn "perflab run" docs/',
    'rg "perflab ab|jmh:run" --files-with-matches',
    'echo "next: perflab run --profile quick"',
    "git commit -m 'explain when to use perflab ab and Jmh/run'",
    'cat perflab.toml && ls perflab/run',
    'which perflab; perflab --version; perflab run --help',
    'perflab report latest',
    'sbt compile "testOnly *JmhRunnerSpec"',
    'java -jar tools/formatter.jar src/jmh',
    'man perflab # then perflab run',
  ]

  for (const command of mentions) {
    expect(`${command} => ${await bash($, command)}`).toBe(`${command} => ran`)
  }

  expect(ran).toEqual(mentions)
  expect(asked).toEqual([]) // agentscope is not even asked
})

test('the gate lets a benchmark through when quiet, when told to, and when it cannot judge', { options: OPTIONS }, async ($, on) => {
  const w: World = { load: QUIET }
  const { ran } = world(on, w)
  expect(await bash($, 'perflab run')).toBe('ran')

  w.load = BUSY
  expect(await bash($, 'LOAD_GATE=off perflab run')).toBe('ran')
  expect(await bash($, 'LOAD_GATE=0.1 perflab run')).toContain('limit 0.1')

  w.load = 'Traceback (most recent call last): no such table' // agentscope broken
  expect(await bash($, 'perflab run')).toBe('ran')

  w.load = { ...BUSY, stale_s: 4000 } // agentscope not sampling
  expect(await bash($, 'perflab run')).toBe('ran')
  expect(ran.length).toBe(4)
})

test('the gate can be turned off', { options: { ...OPTIONS, loadGate: false } }, async ($, on) => {
  world(on, { load: BUSY })
  expect(await bash($, 'perflab run')).toBe('ran')
})

// --- bgrun guard

test('a long command not under bgrun is refused with the wrapped form', { options: OPTIONS }, async ($, on) => {
  const { ran } = world(on)
  const said = await bash($, 'sbt -Dpartest.threads=4 partest')

  expect(said).toContain('bgrun guard: not started. `sbt -Dpartest.threads=4 partest` is a long run (partest)')
  expect(said).toContain('\n  bgrun --label partest -- sbt -Dpartest.threads=4 partest\n')

  expect(await bash($, 'cd /work/scala && sbt "scripted source-dependencies/*" | tee out.log')).toContain(
    "bgrun --label scripted '<the whole command line, as one quoted argument>'",
  )
  expect(await bash($, 'sbt test')).toContain('(test)')
  expect(await bash($, './mvnw -q verify')).toContain('(verify)')
  expect(ran).toEqual([])
})

test('wrapped, short or merely mentioned commands pass the bgrun guard', { options: OPTIONS }, async ($, on) => {
  const { ran } = world(on)
  const fine = [
    'bgrun --label partest -- sbt partest',
    "bgrun --label scripted --progress 'Running' 'cd zinc && sbt scripted'",
    'bgrun --fg --label t -- sbt test',
    'BGRUN=off sbt test',
    'sbt compile',
    'sbt "testOnly scala.tools.nsc.ParserTest"',
    'sbt testQuick',
    'grep -rn "sbt partest" README.md',
    'echo run sbt scripted next',
    'ls test/files/partest',
    'mvn -DskipTests install',
    'bgrun status',
    'bgrun wait 0101-120000-partest',
  ]

  for (const command of fine) {
    expect(`${command} => ${await bash($, command)}`).toBe(`${command} => ran`)
  }

  expect(ran).toEqual(fine)
})

test('the user’s own pattern adds long commands; the guard can be turned off', { options: { ...OPTIONS, longCommands: '^make (all|dist)\\b' } }, async ($, on) => {
  world(on)
  expect(await bash($, 'make all -j8')).toContain('bgrun --label make -- make all -j8')
  expect(await bash($, 'make clean')).toBe('ran')
})

test('the bgrun guard can be turned off', { options: { ...OPTIONS, bgrunGuard: false } }, async ($, on) => {
  world(on)
  expect(await bash($, 'sbt partest')).toBe('ran')
})

// --- spawned-session guard

const SPAWNED = { spawnedFrom: { sessionId: 'local_parent' }, branch: 'side/widgets-1', worktreeName: 'widgets-1', createdAt: STARTED }

test('a spawned session may not write to a repository that is not the user’s', { options: OPTIONS }, async ($, on) => {
  const { ran } = world(on, { meta: SPAWNED, defaultRepo: 'bigco/widgets' })

  for (const command of [
    'gh pr create --repo bigco/widgets --title x --body y',
    'gh pr create --fill', // gh picks the upstream of a fork
    'gh pr comment https://github.com/bigco/widgets/pull/12 --body "ping"',
    'gh issue create -R bigco/widgets -t bug -b text',
    'gh issue comment 5 --repo=bigco/widgets --body hi',
    'cd ../other && gh pr review 12 --approve',
    'GH_REPO=bigco/widgets gh pr close 12',
    'gh api -X POST repos/bigco/widgets/issues/5/comments -f body=hi',
    'git push upstream feature',
    'git push https://github.com/bigco/widgets.git HEAD:refs/heads/x',
  ]) {
    const said = await bash($, command)
    expect(said.startsWith('spawned-session guard') ? 'refused' : `${command} => ${said}`).toBe('refused')
    expect(said).toContain('bigco/widgets, which is not under acme-dev')
    expect(said).toContain('started by local_parent')
  }

  expect(ran).toEqual([])
})

test('a spawned session works freely in the user’s own repositories, and reads anywhere', { options: OPTIONS }, async ($, on) => {
  const fine = [
    'gh pr create --repo acme-dev/widgets --title x --body y',
    'gh pr comment 3 --body done', // default repo is the user's
    'gh pr view 12 --repo bigco/widgets',
    'gh pr list -R bigco/widgets',
    'gh issue view https://github.com/bigco/widgets/issues/5',
    'gh api repos/bigco/widgets/pulls/12',
    'git push origin feature',
    'git push -u origin side/widgets-1',
    'git fetch upstream',
    'git log --oneline -5',
    'echo "gh pr create --repo bigco/widgets"',
  ]
  const { ran } = world(on, { meta: SPAWNED, defaultRepo: 'acme-dev/widgets' })

  for (const command of fine) {
    expect(`${command} => ${await bash($, command)}`).toBe(`${command} => ran`)
  }

  expect(ran).toEqual(fine)
})

test('an undeterminable target is refused, not guessed', { options: OPTIONS }, async ($, on) => {
  world(on, { meta: SPAWNED })
  expect(await bash($, 'gh pr create --fill')).toContain('a repository that could not be determined (name it with --repo)')
})

test('a spawned session force-pushes only branches it created', { options: OPTIONS }, async ($, on) => {
  const { ran } = world(on, {
    meta: SPAWNED,
    reflog: { feature: STARTED / 1000 - 86_400, mine: STARTED / 1000 + 600 },
  })

  for (const command of [
    'git push --force origin feature',
    'git push -f', // the branch checked out is "feature"
    'git push --force-with-lease origin feature',
    'git push origin +feature',
    'git push origin HEAD:feature --force',
    'git push origin --delete feature',
    'git push origin :feature',
    'git -C /work/widgets push -fu origin unknown-branch',
  ]) {
    const said = await bash($, command)
    expect(said.startsWith('spawned-session guard: force-push not run') ? 'refused' : `${command} => ${said}`).toBe('refused')
  }

  expect(ran).toEqual([])

  const own = ['git push --force-with-lease origin mine', 'git push -f origin side/widgets-1', 'git push origin feature']

  for (const command of own) {
    expect(`${command} => ${await bash($, command)}`).toBe(`${command} => ran`)
  }
})

test('a session the user started is not held to any of it', { options: OPTIONS }, async ($, on) => {
  const direct = world(on, { meta: { ...SPAWNED, spawnedFrom: null }, defaultRepo: 'bigco/widgets' })
  expect(await bash($, 'gh pr create --repo bigco/widgets --fill')).toBe('ran')
  expect(await bash($, 'git push --force origin feature')).toBe('ran')
  expect(direct.asked).toEqual([])
})

test('nor is a session outside the desktop app, or one with the guard off', { options: { ...OPTIONS, spawnedGuard: false } }, async ($, on) => {
  world(on, { meta: SPAWNED, defaultRepo: 'bigco/widgets' })
  expect(await bash($, 'gh pr create --repo bigco/widgets --fill')).toBe('ran')
})
