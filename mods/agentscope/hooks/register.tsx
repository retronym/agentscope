// What an agent session cannot see for itself, taken from agentscope, and the rules a session is held to. Each part
// is in its own file and can be turned off by its option (plugin.json, userConfig).
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { band, watchJobs } from './band'
import { loadGate } from './gate'
import { bgrunGuard } from './long'
import { offerPane, pane } from './pane'
import { commands } from './shell'
import { desktopMeta, handoffLine, outwardGuard } from './spawned'

const lastHandoff = atom({ plugin: 'agentscope', key: 'handoff' } as const, '', { shape: 'handoff-1' })

export const register: Register = (on, options) => {
  const has = (name: string) => options[name] !== false
  const owners = String(options.ownOwners ?? 'retronym')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(o => o.toLowerCase())
  const extraLong = typeof options.longCommands === 'string' && options.longCommands !== '' ? new RegExp(options.longCommands) : undefined

  on('session.start', async ($, e, next) => {
    if (has('jobsBand')) {
      watchJobs($)
    }

    if (has('sessionPane')) {
      await offerPane($)
    }

    return next(e)
  })

  if (has('jobsBand')) {
    band(on)
  }

  if (has('sessionPane')) {
    pane(on)
  }

  // One hook for every guard on Bash: each judges the commands the line starts, in turn, and the first reason refuses.
  // A guard that cannot judge (agentscope not running, git or gh failing) lets the command through: these stand in
  // the way of known mistakes, they are not a sandbox.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmds = commands(e.command)
    const guards: (() => Promise<string | undefined>)[] = [
      async () => (has('bgrunGuard') ? bgrunGuard(cmds, e.command, extraLong) : undefined),
      async () => (has('loadGate') ? loadGate($, cmds) : undefined),
      async () => {
        const mayWrite = has('spawnedGuard') && cmds.some(c => /(^|\/)(gh|git)$/.test(c.argv[0] ?? ''))
        const meta = mayWrite ? await desktopMeta($) : undefined

        return meta?.spawnedFrom ? outwardGuard($, cmds, meta, owners) : undefined
      },
    ]

    for (const guard of guards) {
      const deny = await guard().catch(() => undefined)

      if (deny !== undefined) {
        return { deny }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (has('handoffLine') && e.agentId === undefined && !e.isAborted) {
      try {
        const meta = await desktopMeta($)
        const found = meta?.spawnedFrom ? await handoffLine($, await $.session.cwd()) : undefined

        // one line per change of state, not one per turn
        if (found && found.line !== (await read($, lastHandoff))) {
          await update($, lastHandoff, () => found.line)
          await $.process.run(
            [
              '/bin/sh',
              '-c',
              'mkdir -p "$HOME/.claude/side-sessions" && printf "%s %s\\n" "$(date +%H:%M)" "$1" >> "$HOME/.claude/side-sessions/$(date +%F)-$2.md"',
              'sh',
              found.line,
              found.branch.replace(/[^A-Za-z0-9._-]+/g, '-'),
            ],
            { timeoutMs: 5000 },
          )
        }
      } catch {
        // the line is a convenience: a turn never fails for it
      }
    }

    return done
  })
}
