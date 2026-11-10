import { describe, expect, it } from 'vitest'
import type { ExecutionTarget, Ticket } from '../src/core/index.ts'
import { chooseWorkspace, reusableWorkspace, workspaces } from '../src/executor/workspaces.ts'

const ROOT = '/state/work'
const GITHUB: ExecutionTarget = { source: 'github', repository: 'acme/widgets' }
const OTHER: ExecutionTarget = { source: 'github', repository: 'acme/infra' }
const at = (day: number): string => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`

function ticket(id: string, directory: string, createdAt: string, fields: { target?: ExecutionTarget; ended?: boolean } = {}): Ticket {
  return { id, createdAt, title: id, ...fields.ended ? { ended: { at: createdAt, by: 'executor', outcome: 'completed' } } : {},
    ...fields.target ? { target: fields.target } : {}, execution: { name: id, directory, assignment: '' } } as unknown as Ticket
}

describe('the workspace pool', () => {
  it('describes the ticket directories under the root, their latest target and use, and whether an open ticket holds one', () => {
    const tickets = [ticket('a', `${ROOT}/one`, at(1), { target: GITHUB, ended: true }),
      ticket('b', `${ROOT}/two`, at(2), { target: OTHER, ended: true }),
      ticket('c', `${ROOT}/two`, at(3), { target: GITHUB }),
      ticket('d', '/elsewhere/three', at(4), { target: GITHUB, ended: true })]
    expect(workspaces(ROOT, tickets).sort((a, b) => a.directory.localeCompare(b.directory))).toEqual([
      { directory: `${ROOT}/one`, target: 'github\nacme/widgets', lastUsed: at(1), busy: false },
      { directory: `${ROOT}/two`, target: 'github\nacme/widgets', lastUsed: at(3), busy: true },
    ])
  })
  it('picks a free workspace of the ticket\'s target, the least recently used first', () => {
    const tickets = [ticket('a', `${ROOT}/one`, at(1), { target: GITHUB, ended: true }),
      ticket('b', `${ROOT}/two`, at(2), { target: GITHUB, ended: true }),
      ticket('c', `${ROOT}/busy`, at(3), { target: GITHUB }),
      ticket('d', `${ROOT}/other`, at(4), { target: OTHER, ended: true })]
    expect(reusableWorkspace(ROOT, 'github\nacme/widgets', tickets)?.directory).toBe(`${ROOT}/one`)
    expect(reusableWorkspace(ROOT, '', tickets)).toBeUndefined()
  })
  it('creates a directory named after the ticket\'s short name, without its id, when no workspace is free', () => {
    const busy = ticket('a', `${ROOT}/fix-bug`, at(1), { target: GITHUB })
    expect(chooseWorkspace(ROOT, 'github\nacme/widgets', [busy], 'fix-bug')).toBe(`${ROOT}/fix-bug-2`)
    expect(chooseWorkspace(ROOT, 'github\nacme/widgets', [busy], 'plan-color')).toBe(`${ROOT}/plan-color`)
  })
  it('reuses a free directory of the same target and only then makes a new name', () => {
    const ended = ticket('a', `${ROOT}/fix-bug`, at(1), { target: GITHUB, ended: true })
    expect(chooseWorkspace(ROOT, 'github\nacme/widgets', [ended], 'plan-color')).toBe(`${ROOT}/fix-bug`)
    // A local-only ticket does not reuse a repository workspace.
    expect(chooseWorkspace(ROOT, '', [ended], 'report')).toBe(`${ROOT}/report`)
  })
})
