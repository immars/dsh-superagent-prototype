/**
 * Workspace pool: the directories under an execution root, the target each last served, and the choice of a free
 * existing one for a new ticket before a new directory is created.
 *
 * Repository tickets reuse a free workspace of the same execution target. Local-only tickets have no repository to
 * match, so they reuse the free local workspace whose name, earlier Tickets and their Executor Sessions, files or instruction documents
 * best match the incoming work, and create a new directory named after that work when none matches.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

/** The file names and short instruction documents read from a workspace to judge what work it holds. */
export interface WorkspaceFiles {
  /** Paths relative to the workspace, at most two levels deep, such as `code/quant.py`. */
  files: string[]
  /** Text of the workspace's `AGENTS.md`, `README.md` and `NOTES.md`, in that order, when present. */
  docs: string[]
}

/** Reads a workspace's files, injectable so tests can describe one without a directory. */
export type WorkspaceFilesReader = (directory: string) => WorkspaceFiles

/** Dependency, build, cache and VCS directories that say nothing about the work and may be very large. */
const IGNORED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.artifacts', 'dist', 'build', 'target', 'coverage', '.next', '.cache', '.DS_Store'])
/** The instruction documents that describe a workspace's work and conventions. */
const DOCUMENTS = ['AGENTS.md', 'README.md', 'NOTES.md']
/** Bounds that keep judging relevance independent of a workspace's size. */
const MAX_FILES = 200, MAX_DOC_BYTES = 12_000, MAX_DOC_SIZE = 200_000

/** Reads up to two levels of a workspace's files and its short instruction documents, ignoring generated trees. */
export function readWorkspaceFiles(directory: string): WorkspaceFiles {
  const files: string[] = [], docs: string[] = []
  const visit = (current: string, depth: number): void => {
    if (files.length >= MAX_FILES) return
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) return
      if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue
      const path = join(current, entry.name)
      files.push(path.slice(directory.length + 1))
      if (entry.isDirectory() && depth < 2) visit(path, depth + 1)
    }
  }
  visit(directory, 0)
  for (const name of DOCUMENTS) {
    const path = join(directory, name)
    try {
      const info = statSync(path)
      if (!info.isFile() || info.size > MAX_DOC_SIZE) continue
      const text = readFileSync(path, 'utf8').slice(0, MAX_DOC_BYTES)
      if (text) docs.push(text)
    } catch { /* The document is absent or unreadable; the file names and tickets still describe the workspace. */ }
  }
  return { files, docs }
}

/** Words that describe any work, so sharing one says nothing about whether two pieces of work belong together. */
const COMMON = new Set(['the', 'and', 'for', 'from', 'with', 'this', 'that', 'add', 'adds', 'added', 'fix', 'fixes', 'fixed', 'update',
  'updates', 'updated', 'change', 'changes', 'changed', 'support', 'supports', 'implement', 'implements', 'implementation', 'use', 'uses',
  'using', 'make', 'makes', 'create', 'creates', 'build', 'builds', 'run', 'runs', 'new', 'existing', 'current', 'continue', 'work', 'works',
  'workspace', 'workspaces', 'task', 'tasks', 'ticket', 'tickets', 'project', 'projects', 'file', 'files', 'code', 'coding', 'doc', 'docs',
  'document', 'documents', 'test', 'tests', 'review', 'reviews', 'issue', 'issues', 'feature', 'features', 'bug', 'bugs', 'data', 'result',
  'results', 'summary', 'summaries', 'study', 'studies', 'research', 'analysis', 'analyze', 'analyzes', 'plan', 'plans', 'design', 'designs',
  'local', 'only', 'general', 'misc', 'one', 'two', 'three', 'four', 'five', 'more', 'less', 'best', 'better', 'good', 'main',
  'into', 'about', 'over', 'under', 'after', 'before', 'when', 'where', 'what', 'which', 'while', 'then',
  'than', 'also', 'such', 'same', 'other', 'each', 'some', 'any', 'all', 'not', 'but', 'can', 'should', 'must', 'may', 'will', 'would'])
/** Chinese bigrams that describe any work, so sharing one does not establish a subject. */
const COMMON_CJK = new Set(['工作', '任务', '工单', '报告', '研究', '分析', '汇总', '总结', '文件', '代码', '项目', '需求', '实现', '修改', '支持',
  '新增', '更新', '继续', '已有', '当前', '相关', '内容', '数据', '结果', '问题', '使用', '进行', '一个', '这个', '这些', '那些', '需要', '可以',
  '以及', '或者', '如果', '没有', '我们', '你们', '他们', '一下', '那个', '什么', '怎么', '如何', '是否', '并且', '但是', '因为', '所以', '然后',
  '现在', '已经', '还是', '只是', '就是', '不是', '可能', '应该', '里面', '之间', '之后', '之前', '通过', '关于', '对于', '由于', '根据', '按照',
  '比如', '例如'])

/**
 * The subject terms of a text: lower-case Latin words and digit runs, plus every two-character run of Chinese text.
 * Terms that only say what any kind of work is are dropped, so an overlap names a shared subject.
 */
export function subjectTerms(text: string): Set<string> {
  const terms = new Set<string>()
  const lower = text.toLowerCase()
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) if (word.length >= 2 && !COMMON.has(word)) terms.add(word)
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 2 && !COMMON_CJK.has(run)) terms.add(run)
    for (let index = 0; index + 1 < run.length; index++) {
      const pair = run.slice(index, index + 2)
      if (!COMMON_CJK.has(pair)) terms.add(pair)
    }
  }
  return terms
}

/** What an incoming ticket says about its work, beyond the short name that also names a new workspace. */
export interface WorkspaceQuery { name: string; title?: string; scope?: string; request?: string }

/** One free local workspace with the subject terms its directory, Tickets, files and documents carry. */
interface WorkspaceProfile {
  workspace: Workspace
  /** Normalized names of the directory and the Tickets that used it, for an exact-subject match. */
  names: Set<string>
  directory: Set<string>
  ticketNames: Set<string>
  ticketTitles: Set<string>
  files: Set<string>
  docs: Set<string>
}

/** The affinity of a workspace to a query: its match score, why it matched, and whether it matched enough to reuse. */
interface Affinity {
  profile: WorkspaceProfile
  score: number
  nameMatches: number
  titleMatches: number
  contentMatches: number
  relevant: boolean
}

const union = (...sets: Set<string>[]): Set<string> => new Set(sets.flatMap(set => [...set]))

/** The short name a ticket recorded for a workspace carries; its title is also its Executor Session title. */
const ticketName = (ticket: Ticket): string => (ticket.execution?.name ?? '').replace(/[0-9a-f]{12}$/, '').replace(/-$/, '')

/** Describes a free local workspace from its directory name, the tickets that used it, and the files it now holds. */
function profileOf(workspace: Workspace, tickets: readonly Ticket[], read: WorkspaceFilesReader): WorkspaceProfile {
  const related = tickets.filter(ticket => ticket.execution?.directory === workspace.directory)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 8)
  const files = read(workspace.directory)
  return { workspace, names: new Set([basename(workspace.directory).toLowerCase(), ...related.map(ticketName).map(name => name.toLowerCase())]),
    directory: subjectTerms(basename(workspace.directory)),
    ticketNames: union(...related.map(ticket => subjectTerms(ticketName(ticket)))),
    ticketTitles: union(...related.map(ticket => subjectTerms(ticket.title))),
    files: union(...files.files.map(path => subjectTerms(path))),
    docs: union(...files.docs.map(text => subjectTerms(text))) }
}

/**
 * Scores one workspace against the incoming ticket. The name is the assessment's short English description of the
 * work, so a match with the directory or an earlier Ticket name is strong; a title, file or document match is weaker.
 * A workspace is relevant when the name shares at least two subject terms with its name or Tickets, when the ticket title
 * shares at least two with its Tickets' titles, when a name term is backed by two file terms, or when two file terms match.
 * A lone generic term is not enough.
 */
function affinity(profile: WorkspaceProfile, query: WorkspaceQuery): Affinity {
  const name = subjectTerms(query.name), title = subjectTerms(query.title ?? '')
  const scope = subjectTerms(query.scope ?? ''), request = subjectTerms((query.request ?? '').slice(0, 4000))
  const weights = new Map<string, number>()
  const add = (terms: Set<string>, weight: number): void => { for (const term of terms) weights.set(term, Math.max(weights.get(term) ?? 0, weight)) }
  add(profile.directory, 5); add(profile.ticketNames, 4); add(profile.ticketTitles, 3); add(profile.files, 2); add(profile.docs, 1.5)
  const nameMatches = [...name].filter(term => profile.directory.has(term) || profile.ticketNames.has(term)).length
  const titleMatches = [...title].filter(term => profile.directory.has(term) || profile.ticketNames.has(term) || profile.ticketTitles.has(term)).length
  const contentMatches = [...name, ...title].filter(term => profile.files.has(term) || profile.docs.has(term)).length
  let score = 0
  const scoreTerms = (terms: Set<string>, weight: number): void => {
    for (const term of terms) score += weight * (weights.get(term) ?? 0)
  }
  scoreTerms(name, 5); scoreTerms(title, 2); scoreTerms(scope, 1); scoreTerms(request, 0.5)
  // The assessment gives the same short name to the same subject, so an identical directory or Ticket name is decisive
  // also when every word of it is too common to count as a subject term on its own, such as `fix`.
  const base = query.name.toLowerCase()
  const sameName = [...profile.names].some(name => name === base || name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1)))
  if (sameName) score += 100
  const relevant = sameName || nameMatches >= 2 || titleMatches >= 2
    || (nameMatches >= 1 && contentMatches >= 2) || contentMatches >= 2
  return { profile, score, nameMatches, titleMatches, contentMatches, relevant }
}

/** The free local-only workspace most relevant to `query`, or `undefined` when none shares its subject. */
export function relevantWorkspace(root: string, tickets: readonly Ticket[], query: WorkspaceQuery,
  read: WorkspaceFilesReader = readWorkspaceFiles): Workspace | undefined {
  return workspaces(root, tickets).filter(workspace => !workspace.busy && workspace.target === '')
    .map(workspace => affinity(profileOf(workspace, tickets, read), query)).filter(candidate => candidate.relevant)
    .sort((a, b) => b.score - a.score || a.profile.workspace.lastUsed.localeCompare(b.profile.workspace.lastUsed)
      || a.profile.workspace.directory.localeCompare(b.profile.workspace.directory))[0]?.profile.workspace
}

/**
 * The directory a new ticket works in. A repository ticket takes a free workspace prepared for its target; a local-only
 * ticket takes the free local workspace most relevant to what it will do. A new directory is named after the ticket's
 * short English name, which describes the work, with a counter when that name is already a ticket directory.
 */
export function chooseWorkspace(root: string, target: string, tickets: readonly Ticket[], name: string,
  query: Omit<WorkspaceQuery, 'name'> = {}, read: WorkspaceFilesReader = readWorkspaceFiles): string {
  const reusable = target === '' ? relevantWorkspace(root, tickets, { name, ...query }, read) : reusableWorkspace(root, target, tickets)
  if (reusable) return reusable.directory
  const base = WorktreeNameSchema.parse(name)
  const taken = new Set(tickets.flatMap(ticket => ticket.execution?.directory ? [basename(ticket.execution.directory)] : []))
  let directory = base
  for (let counter = 2; taken.has(directory); counter++) directory = `${base}-${counter}`
  return join(root, directory)
}
