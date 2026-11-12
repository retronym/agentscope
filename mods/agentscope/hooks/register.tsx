// What an agent session cannot see for itself, taken from agentscope. Each part is in its own file and can be
// turned off by its option (plugin.json, userConfig).
import type { Register } from 'claude-code'

import { band, watchJobs } from './band'
import { gate } from './gate'
import { offerPane, pane } from './pane'

export const register: Register = (on, options) => {
  const hasBand = options.jobsBand !== false
  const hasPane = options.sessionPane !== false

  on('session.start', async ($, e, next) => {
    if (hasBand) {
      watchJobs($)
    }

    if (hasPane) {
      await offerPane($)
    }

    return next(e)
  })

  if (hasBand) {
    band(on)
  }

  if (hasPane) {
    pane(on)
  }

  if (options.loadGate !== false) {
    gate(on)
  }
}
