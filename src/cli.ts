import { runInternal } from './internal.js'
import { buildProgram } from './program.js'

// Hooks and workers are dispatched before commander parses anything: they are on the agent's
// critical path, and they must never print help text or an error into a session.
if (!(await runInternal(process.argv))) {
  await buildProgram().parseAsync(process.argv)
}
