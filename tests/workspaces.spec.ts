import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import type { ExecutionTarget, Ticket } from '../src/core/index.ts'
import { chooseWorkspace, readWorkspaceFiles, relevantWorkspace, reusableWorkspace, workspaces, type WorkspaceFiles } from '../src/executor/workspaces.ts'

const ROOT = '/state/work'
const GITHUB: ExecutionTarget = { source: 'github', repository: 'acme/widgets' }
const OTHER: ExecutionTarget = { source: 'github', repository: 'acme/infra' }
const at = (day: number): string => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`

function ticket(id: string, directory: string, createdAt: string,
  fields: { target?: ExecutionTarget; ended?: boolean; title?: string; name?: string } = {}): Ticket {
  return { id, createdAt, title: fields.title ?? id, ...fields.ended === false ? {} : { ended: { at: createdAt, by: 'executor', outcome: 'completed' } },
    ...fields.target ? { target: fields.target } : {}, execution: { name: fields.name ?? id, directory, assignment: '' } } as unknown as Ticket
}

/** A file reader for tests: the described content by workspace directory name, empty for another. */
const described = (content: Record<string, WorkspaceFiles>) => (directory: string): WorkspaceFiles =>
  content[basename(directory)] ?? { files: [], docs: [] }

describe('the workspace pool', () => {
  it('describes the ticket directories under the root, their latest target and use, and whether an open ticket holds one', () => {
    const tickets = [ticket('a', `${ROOT}/one`, at(1), { target: GITHUB }),
      ticket('b', `${ROOT}/two`, at(2), { target: OTHER }),
      ticket('c', `${ROOT}/two`, at(3), { target: GITHUB, ended: false }),
      ticket('d', '/elsewhere/three', at(4), { target: GITHUB })]
    expect(workspaces(ROOT, tickets).sort((a, b) => a.directory.localeCompare(b.directory))).toEqual([
      { directory: `${ROOT}/one`, target: 'github\nacme/widgets', lastUsed: at(1), busy: false },
      { directory: `${ROOT}/two`, target: 'github\nacme/widgets', lastUsed: at(3), busy: true },
    ])
  })
  it('picks a free workspace of the ticket\'s target, the least recently used first', () => {
    const tickets = [ticket('a', `${ROOT}/one`, at(1), { target: GITHUB }),
      ticket('b', `${ROOT}/two`, at(2), { target: GITHUB }),
      ticket('c', `${ROOT}/busy`, at(3), { target: GITHUB, ended: false }),
      ticket('d', `${ROOT}/other`, at(4), { target: OTHER })]
    expect(reusableWorkspace(ROOT, 'github\nacme/widgets', tickets)?.directory).toBe(`${ROOT}/one`)
    expect(reusableWorkspace(ROOT, '', tickets)).toBeUndefined()
  })
  it('creates a directory named after the ticket\'s short name, without its id, when no workspace is free', () => {
    const busy = ticket('a', `${ROOT}/fix-bug`, at(1), { target: GITHUB, ended: false })
    expect(chooseWorkspace(ROOT, 'github\nacme/widgets', [busy], 'fix-bug')).toBe(`${ROOT}/fix-bug-2`)
    expect(chooseWorkspace(ROOT, 'github\nacme/widgets', [busy], 'plan-color')).toBe(`${ROOT}/plan-color`)
  })
  it('reuses a free directory of the same target and only then makes a new name', () => {
    const ended = ticket('a', `${ROOT}/fix-bug`, at(1), { target: GITHUB })
    expect(chooseWorkspace(ROOT, 'github\nacme/widgets', [ended], 'plan-color')).toBe(`${ROOT}/fix-bug`)
    // A local-only ticket does not reuse a repository workspace.
    expect(chooseWorkspace(ROOT, '', [ended], 'report')).toBe(`${ROOT}/report`)
  })
  it('reuses the free local workspace whose name and Sessions share the work\'s subject, not merely the oldest', () => {
    const tickets = [ticket('loss', `${ROOT}/quant-loss-study`, at(1), { title: 'NVFP4 量化损失研究', name: 'quant-loss-study-0123456789ab' }),
      ticket('case', `${ROOT}/quant-case-numbers`, at(2), { title: '量化最差个案数值', name: 'quant-case-numbers-0123456789ab' }),
      ticket('jira', `${ROOT}/jira-hourly-report`, at(3), { title: '每小时汇总 J6AITC Bug', name: 'jira-hourly-report-0123456789ab' })]
    const read = described({
      'quant-loss-study': { files: ['code/quant.py', 'report/report.md'], docs: ['# NVFP4 → MXINT8 信息损失研究'] },
      'quant-case-numbers': { files: ['code/case_numbers.py'], docs: ['# 最差个案数值'] },
      'jira-hourly-report': { files: ['NOTES.md'], docs: ['# J6AITC Bug 每小时汇总'] },
    })
    expect(chooseWorkspace(ROOT, '', tickets, 'quant-loss-visualization', { title: '把量化损失画成图', request: '继续做损失分析' }, read))
      .toBe(`${ROOT}/quant-loss-study`)
    expect(relevantWorkspace(ROOT, tickets, { name: 'quant-case-table', title: '个案数值表格' }, read)?.directory)
      .toBe(`${ROOT}/quant-case-numbers`)
  })
  it('uses an earlier Session\'s title when the short names do not share a word', () => {
    const tickets = [ticket('study', `${ROOT}/misc-notes`, at(1), { title: 'NVFP4 量化损失研究', name: 'analysis-one-0123456789ab' })]
    expect(chooseWorkspace(ROOT, '', tickets, 'visual-result', { title: '把量化损失画成图' }, described({}))).toBe(`${ROOT}/misc-notes`)
  })
  it('uses a workspace\'s files and AGENTS.md when its directory and Sessions do not name the subject', () => {
    const tickets = [ticket('scratch', `${ROOT}/scratch-notes`, at(1), { title: '随手记', name: 'scratch-notes-0123456789ab' })]
    const read = described({ 'scratch-notes': { files: ['pipeline.py', 'output/weekly.csv'],
      docs: ['# Report pipeline\nGenerate the weekly report from the collected data.'] } })
    expect(chooseWorkspace(ROOT, '', tickets, 'report-pipeline', { title: '周报流水线', request: '把周报生成做成流水线' }, read))
      .toBe(`${ROOT}/scratch-notes`)
  })
  it('reuses a workspace whose directory or Session carries the same short work name, even when its words are common', () => {
    const tickets = [ticket('a', `${ROOT}/fix-regression`, at(1), { title: 'Fix tr-1', name: 'fix-regression-0123456789ab' }),
      ticket('b', `${ROOT}/fix-regression-2`, at(2), { title: 'Fix tr-2', name: 'fix-regression-0123456789ac' })]
    expect(chooseWorkspace(ROOT, '', tickets, 'fix-regression', { title: 'Fix tr-3' }, described({}))).toBe(`${ROOT}/fix-regression`)
  })
  it('does not reuse a busy or unrelated local workspace, and names the new directory after the work', () => {
    const tickets = [ticket('loss', `${ROOT}/quant-loss-study`, at(1), { title: '量化损失研究', name: 'quant-loss-study-0123456789ab', ended: false }),
      ticket('busy', `${ROOT}/quant-loss-notes`, at(2), { title: '量化损失笔记', name: 'quant-loss-notes-0123456789ab', ended: false })]
    const read = described({ 'quant-loss-study': { files: ['report/report.md'], docs: ['# 量化损失研究'] },
      'quant-loss-notes': { files: ['NOTES.md'], docs: ['# 量化损失笔记'] } })
    // Both could match, but both are taken or unrelated; a new directory carries the work's subject.
    expect(chooseWorkspace(ROOT, '', tickets, 'quantum-error-correction', { title: '量子纠错' }, read)).toBe(`${ROOT}/quantum-error-correction`)
    // A busy workspace is never chosen, even when it is the best match.
    const free = ticket('free', `${ROOT}/quant-loss-review`, at(3), { title: '量化损失复核', name: 'quant-loss-review-0123456789ab' })
    expect(relevantWorkspace(ROOT, [...tickets, free], { name: 'quant-loss-visualization' }, read)?.directory)
      .toBe(`${ROOT}/quant-loss-review`)
  })
})

describe('reading a workspace', () => {
  let directory: string | undefined
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })
  it('reads two levels of names and AGENTS.md, README.md and NOTES.md while skipping dependencies and generated trees', () => {
    directory = mkdtempSync(join(tmpdir(), 'dsh-workspace-'))
    for (const path of ['code/quant.py', 'report/report.md', 'node_modules/pkg/index.js', '.git/config', 'dist/out.js']) {
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), '')
    }
    writeFileSync(join(directory, 'AGENTS.md'), '# Quant loss study\nKeep the report reproducible.')
    writeFileSync(join(directory, 'README.md'), '# NVFP4 study')
    const read = readWorkspaceFiles(directory)
    expect(read.files).toEqual(expect.arrayContaining(['code', 'code/quant.py', 'report/report.md', 'AGENTS.md', 'README.md']))
    expect(read.files.some(path => path.startsWith('node_modules') || path.startsWith('.git') || path.startsWith('dist'))).toBe(false)
    expect(read.docs).toEqual([expect.stringContaining('Quant loss study'), expect.stringContaining('NVFP4 study')])
  })
})
