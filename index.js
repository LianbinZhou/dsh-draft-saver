/**
 * Host half of dsh-draft-saver.
 *
 * The whole feature lives in the browser: mirroring an unsent composer draft
 * and handing it back to a new session touches no session event, no tool, and
 * no model request. This entry exists so the bundle patch can mount one
 * package row whose browser half (`./client`, declared under `dsh.client`)
 * carries the implementation.
 */
export function apply() {}
