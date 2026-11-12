/** One bgrun job of this session, as the band draws it. */
export type Job = {
  id: string
  label: string
  state: 'running' | 'done' | 'failed' | 'lost'
  /** How long it has run, or how it ended and when: "12m", "12m, silent 6m", "exit 1 after 3m, 2m ago". */
  head: string
  /** The last line it printed (or its --progress line). */
  last: string
}

export type Proc = { label: string; pid: number; cores: number; rss: number }
export type Peer = { sid: string; title: string; status: string; cores: number; top: string | null }
export type Pr = { key: string; title: string; url: string | null; state: string; ci: string | null; review: string | null }

/** This session as agentscope sees it: what bin/session_view.py prints. */
export type View =
  | { ok: false; error: string }
  | {
      ok: true
      at: number
      ncpu: number
      mem_total: number
      title: string | null
      status: string
      cores: number
      rss: number
      procs: Proc[]
      jvms: Proc[]
      prs: Pr[]
      parent: Peer | null
      spawned: Peer[]
      others: Peer[]
      others_cores: number
      machine: Record<string, number>
    }

declare module 'claude-code' {
  interface PluginState {
    agentscope: {
      jobs: Shaped<Job[]>
      /** Ids of the jobs whose end has been said in a toast, so a reload does not say it again. */
      announced: Shaped<string[]>
      /** The pane's last answer from agentscope; null before the first. */
      view: Shaped<View | null>
      /** The job whose log tail the pane shows, and that tail; null when none is open. */
      log: Shaped<{ id: string; lines: string[] } | null>
      /** The handoff line last written for this session, so the file gets a line per change, not per turn. */
      handoff: Shaped<string>
    }
  }
}
