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

declare module 'claude-code' {
  interface PluginState {
    agentscope: { jobs: Shaped<Job[]> }
  }
}
