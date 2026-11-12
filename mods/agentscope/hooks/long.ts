// Commands known to run long must go through bgrun, so that the run has a state file: progress on the session card
// and in the jobs band, and an exit code to wait on, in place of a log somebody has to tail. Pure.
import { base, setting } from './shell'
import type { Cmd } from './shell'

const SBT_LONG = /(^|[\s;/"'])(partest|scripted|testAll|test|bootstrap|publishLocal)($|[\s;"'])/

/** The name of the long thing this command runs ("partest"), or undefined. `extra` is the user's own pattern, if any. */
export const longRun = (cmd: Cmd, extra?: RegExp): string | undefined => {
  const name = base(cmd.argv[0])
  const args = cmd.argv.slice(1).join(' ')

  if (/^sbtn?$/.test(name)) {
    return SBT_LONG.exec(args)?.[2]
  }

  if (name === 'partest') {
    return 'partest'
  }

  if (/^mvnw?$/.test(name) && !/-DskipTests|-Dmaven\.test\.skip/.test(args)) {
    return /(^|\s)(verify|install|test)($|\s)/.exec(args)?.[2]
  }

  return extra?.test(cmd.argv.join(' ')) ? name : undefined
}

/** Why this command line should be started another way, or undefined. BGRUN=off on the command overrides. */
export const bgrunGuard = (cmds: Cmd[], line: string, extra?: RegExp): string | undefined => {
  const found = cmds
    .filter(c => !c.wrappers.includes('bgrun') && setting(c, 'BGRUN') !== 'off')
    .map(c => ({ cmd: c, what: longRun(c, extra) }))
    .find(f => f.what !== undefined)

  if (!found) {
    return undefined
  }

  const label = (found.what ?? 'job').replace(/[^A-Za-z0-9]+/g, '-')
  const isAlone = cmds.length === 1 && found.cmd.wrappers.length === 0
  const wrapped = isAlone
    ? `bgrun --label ${label} -- ${line.trim()}`
    : `bgrun --label ${label} '<the whole command line, as one quoted argument>'`

  return (
    `bgrun guard: not started. \`${found.cmd.argv.slice(0, 3).join(' ')}\` is a long run (${found.what}), and long runs go through bgrun ` +
    `so their progress and exit code are visible. Run it as:\n  ${wrapped}\n` +
    `then, in a background Bash call, \`bgrun wait <the id it prints>\`; its exit status is the job's. ` +
    `Read progress with \`bgrun status\`, do not tail the log. If this run is known to be short, prefix it with BGRUN=off.`
  )
}
