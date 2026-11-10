/**
 * Workspace pool: the directories under an execution root, the target each last served, and the choice of a free
 * existing one for a new ticket before a new directory is created.
 */
import { basename, join, sep } from 'node:path'
import type { ExecutionTarget, Ticket } from '../core/index.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'

/** A workspace's target identity: its Source instance and repository, or `''` for a local-only workspace. */
export const workspaceTarget = (target?: ExecutionTarget): string => target ? `${target.source}\n${target.repository}` : ''

/** One directory under an execution root, as the tickets recorded for it describe it. */
export interface Workspace {
  /** The absolute directory, where an Executor Session works. */
  directory: string
  /** Target of the ticket that last used the workspace, matching `workspaceTarget`. */
  target: string
  /** Creation time of the ticket that last used the workspace. */
  lastUsed: string
  /** Whether an open ticket holds the workspace. */
  busy: boolean
}

/**
 * Groups the recorded ticket directories under `root` and describes each one: its target and latest use come from the
 * most recently created ticket recorded for it, and it is busy while any ticket recorded for it is open.
 */
export function workspaces(root: string, tickets: readonly Ticket[]): Workspace[] {
  const found = new Map<string, Workspace>()
  for (const ticket of tickets) {
    const directory = ticket.execution?.directory
    if (!directory || directory !== root && !directory.startsWith(`${root}${sep}`)) continue
    const existing = found.get(directory)
    if (!existing) { found.set(directory, { directory, target: workspaceTarget(ticket.target), lastUsed: ticket.createdAt, busy: !ticket.ended }); continue }
    if (ticket.createdAt > existing.lastUsed) { existing.target = workspaceTarget(ticket.target); existing.lastUsed = ticket.createdAt }
    existing.busy ||= !ticket.ended
  }
  return [...found.values()]
}

/** A free workspace under `root` prepared for `target`, least recently used first, or `undefined`. */
export function reusableWorkspace(root: string, target: string, tickets: readonly Ticket[]): Workspace | undefined {
  return workspaces(root, tickets).filter(workspace => !workspace.busy && workspace.target === target)
    .sort((a, b) => a.lastUsed.localeCompare(b.lastUsed) || a.directory.localeCompare(b.directory))[0]
}

/**
 * The directory a new ticket works in: a free existing workspace prepared for its target, else a new directory named
 * after its short English name, with a counter when that name is already a ticket directory.
 */
export function chooseWorkspace(root: string, target: string, tickets: readonly Ticket[], name: string): string {
  const reusable = reusableWorkspace(root, target, tickets)
  if (reusable) return reusable.directory
  const base = WorktreeNameSchema.parse(name)
  const taken = new Set(tickets.flatMap(ticket => ticket.execution?.directory ? [basename(ticket.execution.directory)] : []))
  let directory = base
  for (let counter = 2; taken.has(directory); counter++) directory = `${base}-${counter}`
  return join(root, directory)
}
