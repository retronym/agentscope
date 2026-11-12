// A Bash tool command line, read well enough to say which programs it starts. Pure.
//
// The guards must not trip on a word that is only mentioned (`grep -r "perflab run" .`, `echo sbt partest`), so a
// command line is split into its simple commands, quotes respected, and each is judged by the program it runs:
// leading VAR=value words and wrappers (time, nohup, env, bgrun, bash -c '...') are peeled off first.

export type Cmd = {
  /** The program and its arguments, quotes removed. */
  argv: string[]
  /** VAR=value words written before it. */
  env: Record<string, string>
  /** What it was wrapped in, outermost first: "bgrun", "time", "bash". */
  wrappers: string[]
  /** The directory an earlier `cd` on the line moved to, when there was one. */
  cd?: string
}

/** Splits on ; & | && || newlines and parentheses outside quotes; each part is a list of words, quotes removed. */
export const split = (line: string): string[][] => {
  const parts: string[][] = []
  let words: string[] = []
  let word = ''
  let isWord = false
  let quote = ''

  const endWord = () => {
    if (isWord) {
      words.push(word)
    }

    word = ''
    isWord = false
  }
  const endPart = () => {
    endWord()

    // redirections are not arguments: `2>&1`, `>out.log`, `> out.log`, `< in`
    const args = words.filter((w, i) => !/^\d*(>>?|<|&>)/.test(w) && !/^\d*(>>?|<|&>)$/.test(words[i - 1] ?? ''))

    if (args.length > 0) {
      parts.push(args)
    }

    words = []
  }

  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? ''

    if (quote) {
      if (c === quote) {
        quote = ''
      } else if (c === '\\' && quote === '"' && i + 1 < line.length) {
        word += line[++i]
      } else {
        word += c
      }
    } else if (c === "'" || c === '"') {
      quote = c
      isWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i] === '\n' ? '' : line[i]
      isWord = true
    } else if (c === '&' && (line[i - 1] === '>' || line[i + 1] === '>')) {
      word += c // 2>&1, &>file: a redirection, not a separator
    } else if (';&|\n(){}'.includes(c) && !(c === '{' || c === '}' ? isWord : false)) {
      endPart()
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else {
      word += c
      isWord = true
    }
  }

  endPart()

  return parts
}

export const base = (path: string | undefined) => (path ?? '').split('/').pop() ?? ''

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
const PLAIN = new Set(['time', 'nohup', 'exec', 'command', 'nice', 'caffeinate', 'env', 'stdbuf', 'unbuffer'])
const SHELLS = new Set(['bash', 'sh', 'zsh'])

const peel = (words: string[], wrappers: string[], env: Record<string, string>, cd: string | undefined, depth: number): Cmd[] => {
  let rest = words

  for (;;) {
    const first = rest[0]
    const assigned = first === undefined ? null : ASSIGN.exec(first)

    if (assigned) {
      env = { ...env, [assigned[1] ?? '']: assigned[2] ?? '' }
      rest = rest.slice(1)
      continue
    }

    const name = base(first)

    if (PLAIN.has(name)) {
      wrappers = [...wrappers, name]
      rest = rest.slice(1)

      // their own flags: -n 5, -i, -o L
      while (rest[0]?.startsWith('-')) {
        rest = rest.slice(/^-[nouie]$/.test(rest[0]) && name !== 'caffeinate' && name !== 'time' ? 2 : 1)
      }

      continue
    }

    if (name === 'timeout' && rest.length > 2) {
      wrappers = [...wrappers, name]
      rest = rest.slice(rest[1]?.startsWith('-') ? 3 : 2)
      continue
    }

    if (name === 'bgrun' && !['wait', 'status', 'stop'].includes(rest[1] ?? '')) {
      let i = 1

      while (rest[i]?.startsWith('--') && rest[i] !== '--') {
        i += rest[i] === '--fg' || rest[i]?.includes('=') ? 1 : 2
      }

      const inner = rest.slice(rest[i] === '--' ? i + 1 : i)

      if (inner.length === 0) {
        break
      }

      wrappers = [...wrappers, 'bgrun']

      // one argument is a shell command line
      if (inner.length === 1 && depth < 4) {
        return parse(inner[0] ?? '', wrappers, env, cd, depth + 1)
      }

      rest = inner
      continue
    }

    if (SHELLS.has(name) && depth < 4) {
      const at = rest.findIndex((w, i) => i > 0 && /^-[a-z]*c$/.test(w))
      const script = at > 0 ? rest[at + 1] : undefined

      if (script !== undefined) {
        return parse(script, [...wrappers, name], env, cd, depth + 1)
      }
    }

    break
  }

  return rest.length > 0 ? [{ argv: rest, env, wrappers, ...(cd === undefined ? {} : { cd }) }] : []
}

const parse = (line: string, wrappers: string[], env: Record<string, string>, cd: string | undefined, depth: number): Cmd[] => {
  const out: Cmd[] = []

  for (const words of split(line)) {
    const cmds = peel(words, wrappers, env, cd, depth)
    out.push(...cmds)

    const only = cmds.length === 1 ? cmds[0] : undefined

    if (only && only.argv[0] === 'cd' && only.argv[1] !== undefined) {
      cd = only.argv[1].startsWith('/') || cd === undefined ? only.argv[1] : `${cd}/${only.argv[1]}`
    }
  }

  return out
}

/** The simple commands a command line starts, in order. */
export const commands = (line: string): Cmd[] => parse(line, [], {}, undefined, 0)

/** `VAR=value` set for this command, on it or on a wrapper around it. */
export const setting = (cmd: Cmd, name: string) => cmd.env[name]
