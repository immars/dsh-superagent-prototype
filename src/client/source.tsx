/** Source status view (health, filtered Triggers, dropped replies) and Source settings cards. */
import { useEffect, useState, type FormEvent } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type SourceStatusRow, type SourceView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Input, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Field, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, errorText, healthText, localized, readableMarkers, reasonLabel, valueLabel, when, type T } from './text.ts'
import { CheckSetupButton, Hint, LabelValue, LoadState, SetupMessage, StatusHead, When } from './widgets.tsx'

/** Display name of a Source instance: its kind title, plus the instance label (or id) for an installed additional instance. */
function sourceName(t: T, source: Pick<SourceView, 'id' | 'kind' | 'label' | 'title' | 'installed'>): string {
  const title = localized(t, source.title)
  return source.installed && source.id !== source.kind ? `${title} · ${source.label ?? source.id}` : title
}
function SourceCard({ source }: { source: SourceView }) {
  const { t, call, notify } = usePanel()
  const { running } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const remove = async () => {
    if (!confirm(t('sourceRemoveConfirm', { name }))) return
    try { await call('DELETE sources/:id', { id: source.id }); await reload() }
    catch (failure) { notify(errorText(failure)) }
  }
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // Saving a modified setup-sensitive field restarts dsh-superagent, interrupting running Assignments.
  const restarts = draft.dirty && source.restarts.some(changed)
  const name = sourceName(t, source)
  const description = localized(t, source.description)
  // Hide derived facts for unsaved field edits until the new value is saved.
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
    labels={source.labels}
    refreshLabels={refreshLabels} fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })} />
  const advanced = source.fields.filter(spec => spec.advanced)
  return <form id={`dt-source-${source.id}`} className="dt-card" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-card-head">
        <div className="dt-row-main">
          <div className="dt-row-title">
            <span className="dt-card-title">{name}</span>{description && <InfoTip text={description} />}
            {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
          </div>
        </div>
        {source.installed && <Switch checked={value.enabled} onChange={enabled => draft.edit({ ...value, enabled })}
          label={t('sourceEnable', { name })} />}
        {source.installed && source.id !== source.kind && <Button variant="ghost" size="sm" icon={<Icon name="dismiss" />}
          onClick={() => { void remove() }}>{t('sourceRemove')}</Button>}
      </div>
      {problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={problem} lead /></p><CheckSetupButton />
      </div>}
      {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
      {source.installed && source.fields.filter(spec => !spec.advanced).map(field)}
      {source.installed && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}>
        <div className="dt-disclosure-body">{advanced.map(field)}</div>
      </DisclosureRow>}
    </Fields>
    <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
      onDiscard={draft.discard} />
  </form>
}

function AddSource() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const [kind, setKind] = useState('')
  const [label, setLabel] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [busy, setBusy] = useState(false)
  const kinds = [...new Map(settings.sources.filter(source => source.installed).map(source => [source.kind, source])).values()]
  const copies = settings.sources.filter(source => source.installed && source.kind === kind)
  useEffect(() => { if (!kind && kinds[0]) setKind(kinds[0].kind) }, [kind, kinds])
  useEffect(() => { setCopyFrom('') }, [kind])
  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!kind) return
    setBusy(true)
    try {
      await call('POST sources', { body: { kind, ...(label.trim() ? { label: label.trim() } : {}), ...(copyFrom ? { copyPolicyFrom: copyFrom } : {}) } })
      setLabel('')
      setCopyFrom('')
      await reload()
      notify(t('sourceAdded', { name: label.trim() || kind }))
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  if (!kinds.length) return null
  return <form className="dt-form dt-add-source" onSubmit={event => { void add(event) }}>
    <div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title"><span className="dt-card-title">{t('sourceAdd')}</span>
      <InfoTip text={t('sourceAddHint')} /></div></div></div>
    <Fields disabled={busy}>
      <Field label={t('sourceAddKind')}>
        <select className="dt-select" value={kind} onChange={event => setKind(event.target.value)}>
          {kinds.map(source => <option key={source.kind} value={source.kind}>{localized(t, source.title)}</option>)}
        </select>
      </Field>
      <Field label={t('sourceAddLabel')}>
        <Input value={label} maxLength={60} placeholder={kind} onChange={event => setLabel(event.target.value)} />
      </Field>
      <Field label={t('sourceAddCopy')} hint={t('sourceAddCopyHint')}>
        <select className="dt-select" value={copyFrom} onChange={event => setCopyFrom(event.target.value)}>
          <option value="">{t('sourceAddNone')}</option>
          {copies.map(source => <option key={source.id} value={source.id}>{source.id === source.kind ? localized(t, source.title) : source.id}</option>)}
        </select>
      </Field>
    </Fields>
    <div className="dt-row-buttons"><Button type="submit" variant="primary" disabled={busy || !kind}>{t('sourceAddSubmit')}</Button></div>
  </form>
}

export function SourceSettings({ focus }: { focus?: string }) {
  const { sources } = useSettings().settings
  useEffect(() => { if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: 'start' }) }, [focus])
  return <div className="dt-form">
    <AddSource />
    {sources.map(source => <SourceCard key={source.id} source={source} />)}
    <ConfigHistory blocks={['source:']} />
  </div>
}

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // Link to the message's Ticket, or fall back to its Thread for messages queued before receipts recorded `ticketId`.
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'execution', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'trigger', id: item.thread }, name: t('term.thread') } : undefined
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}
function SourceRow({ source }: { source: SourceStatusRow }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const [filteredOpen, setFilteredOpen] = useState(false)
  const { problem, dropped } = source
  const { dot, label: state } = sourceMark(t, source.state)
  const { received, filtered, lastAt } = source.stats
  // Omit healthy parts and suppress per-part notes when a setup problem already explains why the Source is stopped.
  const notes = source.enabled && !problem && !setup?.problem ? source.health.filter(item => item.state === 'error'
    || item.state === 'paused') : []
  return <li className="dt-row">
    <Dot state={dot} label={state} />
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-row-name">{sourceName(t, source)}</span><span className="dt-status-text"
        data-state={dot}>{state}</span></div>
      <div className="dt-row-meta">
        {received > 0 && <LabelValue label={t('sourceReceivedLabel')}
          value={received} />}{filtered > 0 && <LabelValue label={t('sourceFilteredLabel')} value={filtered} />}
        {lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(lastAt, t('lang'))} />}
      </div>
      {problem && <p className="dt-error">
        <SetupMessage problem={problem} lead /> <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
          {t('sourceOpenSettings')}
        </button>
      </p>}
      {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
        {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
          item)}</span>
      </p>)}
      {source.filtered.length > 0 && <DisclosureRow icon={<Icon name="filter" />} title={t('sourceFilteredTitle')} open={filteredOpen}
        onToggle={() => setFilteredOpen(!filteredOpen)}>
        <div className="dt-disclosure-body">
          <ul className="dt-list">{source.filtered.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
            className="dt-row-main">
            <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview)
              || t('empty')}</div>
            <div className="dt-row-meta"><Tag tone="neutral">{reasonLabel(t, item.reason)}</Tag><When at={item.at} /></div>
          </div></li>)}</ul>
        </div>
      </DisclosureRow>}
      {dropped.length > 0 && <DroppedReplies items={dropped} />}
    </div>
  </li>
}

export function SourceStatus() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error } = usePoll(() => call('GET sources'), [])
  // Global deployment setup problems halt all Sources and show at the top; Source-specific setup problems show on that Source's row.
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} settings="source" />
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
    </p>}
    <LoadState error={error} loading={!data} />
    {data && <ul className="dt-list">{data.map(source => <SourceRow key={source.id} source={source} />)}</ul>}
  </div>
}
