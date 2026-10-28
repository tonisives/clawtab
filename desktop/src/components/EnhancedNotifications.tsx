import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { EnhancedNotificationSettings } from "../types"
import html from "../../../shared/src/nfn/surface.html?raw"
import css from "../../../shared/src/nfn/surface.css?raw"
import script from "../../../shared/src/nfn/surface.js?raw"
import "./EnhancedNotifications.css"

type Template = { id: string; name: string; layout: unknown[]; actions: unknown[] }
type TemplateList = { templates: Template[]; sources: Record<string, string>; directory: string; errors: { path: string; error: string }[] }
type Info = {
  records: unknown[]
  pending_count: number
  auto_yes_panes: string[]
  settings: EnhancedNotificationSettings
  templates: TemplateList
  platform: { focus_shortcut_error?: string; available: boolean; focused: boolean | null; authorized: boolean | null; displays: { id: string; name: string }[] }
}

const surfaceDocument = html.replace("/* NFN_CSS */", css + "\nbody{display:flex;justify-content:center;padding:12px 4px;overflow:auto}#surface{flex-shrink:0;max-width:calc(100vw - 8px)}")
  .replace("/* NFN_JS */", script)

export function nfnCommand<T>(command: object): Promise<T> {
  return invoke<T>("nfn_command", { command })
}

function NotificationSurface({ snapshot, inbox = false }: { snapshot: object; inbox?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const send = useCallback((value: object) => frame.current?.contentWindow?.postMessage(value, "*"), [])
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data?.nfn) return
      const value = event.data.nfn
      if (value.preview_ready) { setReady(true); send(snapshotRef.current); if (inbox) send({ type: "show" }); return }
      if (!inbox || !value.command) return
      try {
        const result = await nfnCommand(value.command)
        send({ type: "response", token: value.token, value: result })
      } catch (error) { send({ type: "response", token: value.token, error: String(error) }) }
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [inbox, send])
  useEffect(() => { if (ready) send(snapshot) }, [snapshot, ready, send])

  return <iframe ref={frame} title={inbox ? "Notification inbox" : "Notification layout preview"}
    className="nfn-surface-frame" sandbox="allow-scripts" srcDoc={surfaceDocument}
    onLoad={() => { setReady(true); send(snapshotRef.current); if (inbox) send({ type: "show" }) }} />
}

const newTemplate = `version: 1
id: my-review
name: My review
layout:
  - type: text
    field: body
  - type: media
  - type: choices
  - type: reply
  - type: logs
actions:
  - id: approve
    label: Approve
  - id: revise
    label: Request changes
  - id: reject
    label: Reject
`

export function EnhancedNotifications({ settings: initialSettings, onChange }: {
  settings: EnhancedNotificationSettings
  onChange: (settings: EnhancedNotificationSettings) => Promise<void>
}) {
  const [info, setInfo] = useState<Info | null>(null)
  const settings = info?.settings ?? initialSettings
  const [error, setError] = useState("")
  const [editor, setEditor] = useState(false)
  const [inbox, setInbox] = useState(false)
  const [selected, setSelected] = useState("social-review")
  const [yaml, setYaml] = useState("")
  const [validated, setValidated] = useState<Template | null>(null)
  const [validation, setValidation] = useState("")
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const refresh = useCallback(() => nfnCommand<Info>({ op: "info" }).then(value => { setInfo(value); setError("") }).catch(e => setError(String(e))), [])
  useEffect(() => {
    void refresh()
    const unlisten = listen("nfn-changed", () => { void refresh() })
    return () => { void unlisten.then(fn => fn()) }
  }, [refresh])
  useEffect(() => {
    if (!yaml) return
    let cancelled = false
    setValidated(null); setValidation("Checking layout...")
    const timer = window.setTimeout(() => {
      nfnCommand<{ template: Template }>({ op: "validate", yaml }).then(value => {
        if (!cancelled) { setValidated(value.template); setValidation("") }
      }).catch(e => { if (!cancelled) setValidation(String(e)) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [yaml])

  const change = (patch: Partial<EnhancedNotificationSettings>) => {
    void nfnCommand<{ settings: EnhancedNotificationSettings }>({ op: "save_settings", patch })
      .then(async value => { setInfo(current => current ? { ...current, settings: value.settings } : current); await onChange(value.settings) })
      .catch(e => setError(String(e)))
  }
  const chooseTemplate = (id: string) => { setSelected(id); setYaml(id === "new" ? newTemplate : info?.templates.sources[id] || ""); setSaved(false) }
  const save = async () => {
    setSaving(true); setError("")
    try {
      const result = await nfnCommand<{ template: Template }>({ op: "save_template", yaml })
      await refresh(); setSelected(result.template.id); setSaved(true)
    } catch (e) { setError(String(e)) } finally { setSaving(false) }
  }
  const sampleTemplate = validated || info?.templates.templates.find(t => t.id === "social-review")
  const sample = {
    id: "layout-preview", status: "pending", created_at: Date.now(), read_at: null, dismissed_at: null,
    request: {
      title: "Review the launch post", template: sampleTemplate?.id || "social-review",
      body: "The launch post and video are ready. Review the caption and choose how to continue.",
      source: { pane_id: "%preview", task: "Review the launch post", provider: "codex", branch: "launch", cwd: "~/projects/clawtab" },
      response_destination: "agent_message",
      data: { command: "launchctl bootstrap gui/501 ~/Library/LaunchAgents/example.plist", diff: "- Previous caption\n+ Updated launch caption", plan: "1. Review the draft\n2. Publish after approval" },
      actions: sampleTemplate?.actions?.length ? sampleTemplate.actions : [{ id: "approve", label: "Approve" }, { id: "revise", label: "Request changes" }, { id: "reject", label: "Reject" }], media: [],
    },
  }
  const previewSnapshot = { type: "snapshot", preview: true, visible: true, records: [sample], pending_count: 1,
    arrival: sample.id, settings, templates: { templates: sampleTemplate ? [sampleTemplate] : [] } }
  const inboxSnapshot = { ...info, type: "snapshot", preview: false, visible: true }

  return <div className="nfn-settings">
    <div className="nfn-settings-grid">
      <label>Delivery<select value={settings.delivery} onChange={e => change({ delivery: e.target.value as EnhancedNotificationSettings["delivery"] })}>
        <option value="enhanced">Enhanced cards</option><option value="native">macOS notifications</option><option value="both">Both</option>
      </select></label>
      <label>Position<select value={settings.placement} onChange={e => change({ placement: e.target.value as EnhancedNotificationSettings["placement"] })}>
        <option value="notch">Notch, with right column fallback</option><option value="right">Right column</option>
        {settings.position && <option value="custom">Dragged position</option>}
      </select></label>
      <label>Focus / Do Not Disturb<select value={settings.focus} onChange={e => change({ focus: e.target.value as EnhancedNotificationSettings["focus"] })}>
        <option value="follow">Follow macOS</option><option value="independent">Independent of macOS Focus</option>
      </select></label>
      <label>Display<select value={settings.display} onChange={e => change({ display: e.target.value })}>
        <option value="primary">System primary display</option><option value="built_in">Built-in display</option><option value="pointer">Display with pointer</option>
        {info?.platform.displays.map(display => <option key={display.id} value={display.id}>{display.name}</option>)}
      </select></label>
      <label>Status update duration (seconds)<input type="number" min={2} max={120} value={settings.preview_seconds}
        onChange={e => { const seconds = Number(e.target.value); if (seconds >= 2 && seconds <= 120) change({ preview_seconds: seconds }) }} /></label>
      <label>Idle time before mobile delivery (seconds)<input type="number" min={10} max={3600} value={settings.idle_seconds ?? 60}
        onChange={e => { const seconds = Number(e.target.value); if (seconds >= 10 && seconds <= 3600) change({ idle_seconds: seconds }) }} /></label>
      <label>Focus message bar shortcut<input aria-label="Focus message bar shortcut" defaultValue={settings.focus_shortcut ?? "Ctrl+Alt+w"} onBlur={e => change({ focus_shortcut: e.target.value })} /></label>
      <div className="nfn-options">
        <label className="checkbox-label"><input type="checkbox" checked={settings.keyboard_hints ?? false} onChange={e => change({ keyboard_hints: e.target.checked })} />Keyboard hints (double Option while the bar is focused)</label>
        <label className="checkbox-label"><input type="checkbox" checked={settings.hover_expand} onChange={e => change({ hover_expand: e.target.checked })} />Expand on hover</label>
        <label className="checkbox-label"><input type="checkbox" checked={settings.sound} onChange={e => change({ sound: e.target.checked })} />Sound</label>
        <label className="checkbox-label"><input type="checkbox" checked={settings.menu_bar_icon} onChange={e => change({ menu_bar_icon: e.target.checked })} />Menu bar icon</label>
        <label className="checkbox-label"><input type="checkbox" checked={settings.mobile_when_idle ?? true} onChange={e => change({ mobile_when_idle: e.target.checked })} />Send pending messages to mobile when this Mac is idle, locked, or asleep</label>
      </div>
    </div>
    <span className="hint">Review and permission cards stay open until answered or closed. Status updates pause on hover.</span>
    {settings.focus === "follow" && info && (info.platform.focused === null || info.platform.authorized !== true) &&
      <span className="hint">macOS notifications handle delivery until ClawTab Daemon has notification and Focus access. Enable them in System Settings.</span>}
    <div className="btn-group nfn-toolbar">
      <button className="btn btn-sm" onClick={() => setInbox(!inbox)}>{inbox ? "Close inbox" : `Open inbox${info ? ` (${info.pending_count})` : ""}`}</button>
      <button className="btn btn-sm" disabled={!info} onClick={() => { if (!editor) chooseTemplate(selected); setEditor(!editor) }}>{editor ? "Close layout editor" : "Layouts and preview"}</button>
    </div>
    {inbox && info && <NotificationSurface inbox snapshot={inboxSnapshot} />}
    {editor && <div className="nfn-editor">
      <label>Layout<select value={selected} onChange={e => chooseTemplate(e.target.value)}>
        {info?.templates.templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        <option value="new">New layout</option>
      </select></label>
      <span className="hint">Edit YAML primitives and save a layout. Preview actions stay in the preview.</span>
      <textarea className="nfn-yaml" aria-label="Notification layout YAML" spellCheck={false} value={yaml} onChange={e => { setYaml(e.target.value); setSaved(false) }} />
      {validation && <span className="nfn-error" role="status">{validation}</span>}
      <div className="btn-group"><button className="btn btn-sm btn-primary" disabled={!validated || saving} onClick={() => void save()}>{saving ? "Saving..." : "Save layout"}</button>{saved && <span className="hint">Saved</span>}</div>
      <NotificationSurface snapshot={previewSnapshot} />
      <span className="hint">Layout files: {info?.templates.directory}</span>
      {info?.templates.errors.map(item => <span key={item.path} className="nfn-error">{item.path}: {item.error}</span>)}
    </div>}
    {info?.platform.focus_shortcut_error && <span className="nfn-error" role="status">{info.platform.focus_shortcut_error}</span>}
    {error && <span className="nfn-error" role="status">{error}</span>}
  </div>
}
