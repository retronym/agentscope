// A session that another session started works for a coordinator, not directly for the user, and has overstepped
// before: an upstream PR opened without sign-off, history rewritten under the session that owned the branch. Two
// things hold such a session to the rules in the user's CLAUDE.md ("Spawned sessions"), and only such a session:
//
// - outwardGuard: no PR, issue, comment, review or push outside the user's own GitHub owners, and no force-push
//   to a branch this session did not create.
// - handoff: at the end of a turn, one line of facts from git and gh (not from the model) in ~/.claude/side-sessions/.
import type { EngineInterface } from 'claude-code'

import { base } from './shell'
import type { Cmd } from './shell'

type Meta = { spawnedFrom?: { sessionId?: string; name?: string } | null; branch?: string; worktreeName?: string; createdAt?: number }

/**
 * The desktop app's record of this session, which says who started it (`spawnedFrom`). CLAUDE_CODE_CHILD_SESSION is
 * set in every desktop session, so it says nothing. Undefined outside the desktop app: such a session is not spawned.
 */
export async function desktopMeta($: EngineInterface): Promise<Meta | undefined> {
  const [home, account, org, local] = [
    await $.env.get('HOME'),
    await $.env.get('CLAUDE_CODE_ACCOUNT_UUID'),
    await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID'),
    await $.env.get('CLAUDE_CODE_HOST_SESSION_ID'),
  ]

  if (!home || !account || !org || !local) {
    return undefined
  }

  const path = `${home}/Library/Application Support/Claude/claude-code-sessions/${account}/${org}/${local}.json`

  return (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as Meta) : undefined
}

async function git($: EngineInterface, cwd: string, ...args: string[]) {
  const ran = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 10_000 })

  return ran.exitCode === 0 ? ran.stdout.trim() : undefined
}

/** owner/name of a GitHub remote URL; undefined for anything else (a path, another host). */
export const githubRepo = (url: string | undefined) => /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '')?.slice(1, 3).join('/')

const isOwn = (repo: string, owners: string[]) => owners.includes((repo.split('/')[0] ?? '').toLowerCase())

const GH_WRITES: Record<string, string[]> = {
  pr: ['create', 'comment', 'review', 'close', 'merge', 'edit', 'ready', 'reopen'],
  issue: ['create', 'comment', 'close', 'edit', 'reopen', 'delete', 'transfer'],
}

const flag = (argv: string[], short: string, long: string) => {
  const at = argv.findIndex(a => a === short || a === long || a.startsWith(`${long}=`))
  const word = argv[at]

  return at < 0 || word === undefined ? undefined : word.includes('=') ? word.slice(word.indexOf('=') + 1) : argv[at + 1]
}

async function ghTarget($: EngineInterface, cmd: Cmd, cwd: string): Promise<{ what: string; repo: string | undefined } | undefined> {
  const [, noun, verb] = cmd.argv
  const rest = cmd.argv.slice(1)

  if (noun === 'api') {
    const method = (flag(rest, '-X', '--method') ?? '').toUpperCase()
    const isWrite = (method !== '' && method !== 'GET') || rest.some(a => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a))
    const path = rest.find(a => /^\/?(repos\/|graphql$)/.test(a))

    if (!isWrite || path === undefined) {
      return undefined
    }

    return { what: `gh api ${method || 'POST'} ${path}`, repo: /^\/?repos\/([^/]+\/[^/]+)/.exec(path)?.[1] }
  }

  if (noun === undefined || verb === undefined || !GH_WRITES[noun]?.includes(verb)) {
    return undefined
  }

  const named = flag(rest, '-R', '--repo') ?? cmd.env['GH_REPO']
  const url = rest.map(a => /github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\//.exec(a)?.[1]).find(Boolean)
  const what = `gh ${noun} ${verb}`

  if (named ?? url) {
    return { what, repo: (named ?? url ?? '').replace(/^https?:\/\/github\.com\//, '').replace(/^github\.com\//, '') }
  }

  // what gh itself would pick here: for a fork that is usually the upstream repository
  const ran = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd, timeoutMs: 15_000 })

  return { what, repo: ran.exitCode === 0 ? ran.stdout.trim() || undefined : undefined }
}

type Push = { cwd: string; remote: string | undefined; isForce: boolean; branches: string[] }

/** `git [-C dir] push ...` read for where it goes and whether it rewrites; undefined for any other git command. */
export const readPush = (cmd: Cmd, cwd: string): Push | undefined => {
  let args = cmd.argv.slice(1)

  while (args[0]?.startsWith('-')) {
    if (args[0] === '-C' && args[1] !== undefined) {
      cwd = args[1].startsWith('/') ? args[1] : `${cwd}/${args[1]}`
    }

    args = args.slice(args[0] === '-C' || args[0] === '-c' ? 2 : 1)
  }

  if (args[0] !== 'push') {
    return undefined
  }

  const flags = args.slice(1).filter(a => a.startsWith('-'))
  const [remote, ...specs] = args.slice(1).filter((a, i, all) => !a.startsWith('-') && !['-o', '--push-option', '--repo'].includes(all[i - 1] ?? ''))
  const isDelete = flags.some(f => f === '-d' || f === '--delete')
  const isForce =
    isDelete ||
    flags.some(f => /^(-[a-zA-Z]*f[a-zA-Z]*|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--prune)$/.test(f)) ||
    specs.some(s => s.startsWith('+') || s.startsWith(':'))

  return { cwd, remote, isForce, branches: specs.map(s => (s.split(':').pop() ?? s).replace(/^\+/, '').replace(/^refs\/heads\//, '')) }
}

/** Whether this session made the branch: the app made it for the session's worktree, or its history starts after the session did. */
async function isOwnBranch($: EngineInterface, meta: Meta, cwd: string, branch: string) {
  if (meta.branch === branch && meta.worktreeName) {
    return true
  }

  const log = await git($, cwd, 'reflog', 'show', '--format=%gd', '--date=unix', `refs/heads/${branch}`)
  const first = /@\{(\d+)\}\s*$/.exec(log ?? '')?.[1]

  return first !== undefined && meta.createdAt !== undefined && Number(first) * 1000 >= meta.createdAt - 60_000
}

/** Why a spawned session may not run this command line, or undefined. Asked only in a spawned session. */
export async function outwardGuard($: EngineInterface, cmds: Cmd[], meta: Meta, owners: string[]): Promise<string | undefined> {
  const from = meta.spawnedFrom?.sessionId ?? 'another session'
  const rule = `This session was started by ${from}, and a spawned session leaves that to the user: prepare the branch and the text, then stop and report.`
  const sessionCwd = await $.session.cwd()

  for (const cmd of cmds) {
    const cwd = cmd.cd === undefined ? sessionCwd : cmd.cd.startsWith('/') ? cmd.cd : `${sessionCwd}/${cmd.cd}`
    const name = base(cmd.argv[0])

    if (name === 'gh') {
      const target = await ghTarget($, cmd, cwd)

      if (target && (target.repo === undefined || !isOwn(target.repo, owners))) {
        return (
          `spawned-session guard: \`${target.what}\` not run. It would write to ${target.repo ?? 'a repository that could not be determined (name it with --repo)'}, ` +
          `which is not under ${owners.join(', ')}. ${rule}`
        )
      }
    }

    const push = name === 'git' ? readPush(cmd, cwd) : undefined

    if (push) {
      const remote = push.remote ?? (await git($, push.cwd, 'rev-parse', '--abbrev-ref', '@{push}'))?.split('/')[0] ?? 'origin'
      const url = /^[\w.-]+$/.test(remote) ? await git($, push.cwd, 'remote', 'get-url', '--push', remote) : remote
      const repo = githubRepo(url)

      if (repo !== undefined && !isOwn(repo, owners)) {
        return `spawned-session guard: \`git push\` not run. Remote ${remote} is ${repo}, which is not under ${owners.join(', ')}. ${rule}`
      }

      if (push.isForce) {
        const branches = push.branches.length > 0 ? push.branches : [(await git($, push.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')) ?? '']

        for (const branch of branches) {
          if (!(await isOwnBranch($, meta, push.cwd, branch))) {
            return (
              `spawned-session guard: force-push not run. Branch ${branch || '(unknown)'} was not created by this session, and a spawned session ` +
              `does not rewrite or delete what it did not create. Add commits on top, or push your own branch and say so in the report.`
            )
          }
        }
      }
    }
  }

  return undefined
}

/**
 * The handoff line, from git and gh: `repo · branch · pushed? · PR · what is unverified`. The last part is what these
 * tools can see is unfinished (uncommitted files, unpushed commits, CI), never a claim that the work was checked.
 */
export async function handoffLine($: EngineInterface, cwd: string): Promise<{ branch: string; line: string } | undefined> {
  const branch = await git($, cwd, 'rev-parse', '--abbrev-ref', 'HEAD')

  if (branch === undefined) {
    return undefined
  }

  const origin = await git($, cwd, 'remote', 'get-url', 'origin')
  const repo = githubRepo(origin) ?? base(await git($, cwd, 'rev-parse', '--show-toplevel')) ?? '?'
  const head = (await git($, cwd, 'rev-parse', '--short', 'HEAD')) ?? '?'
  const dirty = ((await git($, cwd, 'status', '--porcelain')) ?? '').split('\n').filter(Boolean).length
  const remoteRef = await git($, cwd, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`)
  const ahead = remoteRef === undefined ? undefined : Number((await git($, cwd, 'rev-list', '--count', `origin/${branch}..HEAD`)) ?? 0)
  const pushed = remoteRef === undefined ? `local only (${head})` : ahead === 0 ? `pushed (origin/${branch} @ ${head})` : `pushed, but ${ahead} commits are local only (${head})`

  let pr = 'PR unknown (gh did not answer)'
  let ci = ''

  try {
    const ran = await $.process.run(['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'url,state,isDraft,statusCheckRollup'], {
      cwd,
      timeoutMs: 15_000,
    })

    if (ran.exitCode === 0) {
      const [found] = JSON.parse(ran.stdout) as { url: string; state: string; isDraft: boolean; statusCheckRollup?: { conclusion?: string; status?: string; state?: string }[] }[]
      const checks = (found?.statusCheckRollup ?? []).map(c => c.conclusion || c.state || c.status || '')
      pr = found ? `${found.url} (${found.isDraft ? 'DRAFT' : found.state})` : 'PR none'
      ci = checks.some(c => /FAIL|ERROR|TIMED_OUT|CANCELLED/.test(c)) ? 'CI failing' : checks.some(c => /PENDING|IN_PROGRESS|QUEUED|EXPECTED/.test(c)) ? 'CI running' : ''
    }
  } catch {
    // no gh, or no network: said above
  }

  const open = [dirty > 0 ? `${dirty} uncommitted files` : '', ahead ? `${ahead} unpushed commits` : '', ci].filter(Boolean)

  return { branch, line: `${repo} · ${branch} · ${pushed} · ${pr} · unverified: ${open.length > 0 ? open.join(', ') : 'nothing git or gh can see'} (written by the agentscope mod from git and gh)` }
}
