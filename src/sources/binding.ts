/** Hidden, machine-readable ticket marker in a pull or merge request body. */
const MARKER = /<!--\s*dsh-superagent:ticket=([A-Za-z0-9_-]+)\s*-->/gi

/**
 * Returns the one ticket a change request's body claims, or undefined when the body carries no marker or more than one
 * distinct one. The marker is only a hint: the Source still checks the author, repository, and commit history before it
 * binds the request to that ticket.
 */
export function ticketMarker(body: string | null | undefined): string | undefined {
  const ids = new Set([...String(body ?? '').matchAll(MARKER)].map(match => match[1]!))
  return ids.size === 1 ? [...ids][0] : undefined
}

/** The hidden marker line to put in a change request body for `ticketId`. */
export const ticketMarkerLine = (ticketId: string): string => `<!-- dsh-superagent:ticket=${ticketId} -->`
