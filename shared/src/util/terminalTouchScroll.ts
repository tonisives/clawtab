import type { Terminal } from "@xterm/xterm"

export let attachTerminalTouchScroll = (element: HTMLElement, terminal: Terminal) => {
  let lastTouch: { x: number; y: number; time: number } | null = null
  let origin: { x: number; y: number } | null = null
  let dragging = false
  let velocity = 0
  let remainder = 0
  let frame = 0
  let screenOffset = 0
  let stop = () => { cancelAnimationFrame(frame); frame = 0 }
  let scroll = (pixels: number) => {
    let screen = element.querySelector<HTMLElement>(".xterm-screen")
    let rowHeight = screen ? screen.getBoundingClientRect().height / Math.max(1, terminal.rows) : 0
    if (!rowHeight) return false
    let buffer = terminal.buffer.active
    let gridOverflow = Math.max(0, rowHeight * terminal.rows - element.clientHeight)
    let previous = buffer.viewportY * rowHeight + screenOffset
    let next = Math.max(0, Math.min(buffer.baseY * rowHeight + gridOverflow, previous + pixels + remainder))
    let line = Math.min(buffer.baseY, Math.floor(next / rowHeight))
    terminal.scrollToLine(line)
    screenOffset = line === buffer.baseY ? Math.max(0, next - line * rowHeight) : 0
    remainder = line < buffer.baseY ? next - line * rowHeight : 0
    let surface = element.querySelector<HTMLElement>(".xterm")
    if (surface) surface.style.transform = screenOffset ? `translateY(${-screenOffset}px)` : ""
    return Math.abs(next - previous) > 0.1
  }
  let start = (event: TouchEvent) => {
    stop()
    if (event.touches.length !== 1 || terminal.hasSelection()) { lastTouch = null; return }
    let touch = event.touches[0]
    lastTouch = { x: touch.clientX, y: touch.clientY, time: performance.now() }
    origin = { x: touch.clientX, y: touch.clientY }
    dragging = false
    velocity = 0
    remainder = 0
  }
  let move = (event: TouchEvent) => {
    if (!lastTouch || !origin || event.touches.length !== 1 || terminal.hasSelection()) return
    let touch = event.touches[0]
    let distanceY = origin.y - touch.clientY
    if (!dragging && (Math.abs(distanceY) < 8 || Math.abs(distanceY) < Math.abs(origin.x - touch.clientX))) return
    dragging = true
    event.preventDefault()
    event.stopImmediatePropagation()
    let now = performance.now()
    let delta = lastTouch.y - touch.clientY
    velocity = Math.max(-4, Math.min(4, delta / Math.max(1, now - lastTouch.time)))
    scroll(delta)
    lastTouch = { x: touch.clientX, y: touch.clientY, time: now }
  }
  let end = () => {
    if (dragging && lastTouch && performance.now() - lastTouch.time < 100) {
      let previous = performance.now()
      let step = (now: number) => {
        let elapsed = Math.min(32, now - previous)
        previous = now
        let moved = scroll(velocity * elapsed)
        velocity *= Math.pow(0.92, elapsed / 16)
        frame = moved && Math.abs(velocity) >= 0.02 ? requestAnimationFrame(step) : 0
      }
      frame = requestAnimationFrame(step)
    }
    lastTouch = null
    origin = null
    dragging = false
  }
  let cancel = () => { lastTouch = null; origin = null; dragging = false; stop() }
  element.addEventListener("touchstart", start, { capture: true, passive: true })
  element.addEventListener("touchmove", move, { capture: true, passive: false })
  element.addEventListener("touchend", end, true)
  element.addEventListener("touchcancel", cancel, true)
  element.addEventListener("wheel", stop, { passive: true })
  return () => {
    stop()
    element.removeEventListener("touchstart", start, true)
    element.removeEventListener("touchmove", move, true)
    element.removeEventListener("touchend", end, true)
    element.removeEventListener("touchcancel", cancel, true)
    element.removeEventListener("wheel", stop)
  }
}
