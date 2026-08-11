// A small drawing pad for handwritten notes, with a coloured-pencil feel.
//
// A plain stroked path reads as marker, not pencil. Pencil looks the way it
// does because pigment catches unevenly on paper grain, so each segment here is
// laid down as several thin, semi-transparent passes jittered a fraction of a
// pixel apart. They build up dark where the hand goes slowly or doubles back,
// exactly as a real pencil does.

const PASTELS = [
  '#f2a3b3', // pink
  '#f6c99a', // peach
  '#f3e3a3', // butter
  '#a9d9bd', // mint
  '#a3c9e8', // sky
  '#c3b3e6', // lilac
  '#6f6862', // graphite
]

// Pastel tints and a couple of deeper shades for a hue, so the popup offers
// something usable without turning into a full colour wheel.
function tintsFor(hue) {
  const out = []
  for (const [s, l] of [
    [70, 86],
    [62, 78],
    [58, 70],
    [52, 62],
    [46, 52],
    [40, 40],
  ]) {
    out.push(`hsl(${hue} ${s}% ${l}%)`)
  }
  return out
}

export class Sketch {
  constructor({ canvas, swatches, toggle, popover, grid, hue, clearButton }) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.toggle = toggle
    this.popover = popover
    this.grid = grid
    this.hue = hue
    this.colour = PASTELS[0]
    this.drawing = false
    this.dirty = false
    this.last = null
    this.sized = false

    this.buildSwatches(swatches)
    this.buildPicker()

    clearButton.addEventListener('click', () => this.clear())

    canvas.addEventListener('pointerdown', (e) => this.start(e))
    canvas.addEventListener('pointermove', (e) => this.move(e))
    canvas.addEventListener('pointerup', (e) => this.end(e))
    canvas.addEventListener('pointercancel', (e) => this.end(e))
    canvas.addEventListener('pointerleave', (e) => this.end(e))
  }

  buildSwatches(container) {
    this.swatchEls = PASTELS.map((colour, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'swatch'
      b.style.setProperty('--c', colour)
      b.setAttribute('aria-label', `Colour ${i + 1}`)
      b.addEventListener('click', () => {
        this.colour = colour
        this.picker.value = colour
        this.markActive(b)
      })
      container.append(b)
      return b
    })
    this.markActive(this.swatchEls[0])
  }

  markActive(el) {
    for (const s of this.swatchEls) s.classList.toggle('is-active', s === el)
    this.toggle.classList.toggle('is-active', el === null)
  }

  buildPicker() {
    const paint = () => {
      this.grid.textContent = ''
      for (const colour of tintsFor(Number(this.hue.value))) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'tint'
        b.style.setProperty('--c', colour)
        b.setAttribute('aria-label', colour)
        b.addEventListener('click', () => {
          this.colour = colour
          this.toggle.style.setProperty('--picked', colour)
          this.markActive(null)
          this.closePicker()
        })
        this.grid.append(b)
      }
    }

    paint()
    this.hue.addEventListener('input', paint)

    this.toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      this.popover.hidden ? this.openPicker() : this.closePicker()
    })
    this.popover.addEventListener('click', (e) => e.stopPropagation())
    document.addEventListener('click', () => this.closePicker())
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePicker()
    })
  }

  openPicker() {
    this.popover.hidden = false
    this.toggle.setAttribute('aria-expanded', 'true')
  }

  closePicker() {
    this.popover.hidden = true
    this.toggle.setAttribute('aria-expanded', 'false')
  }

  // Kept in step with the CSS box rather than sized once. A one-shot version
  // leaves the backing store at the default 300x150 whenever the pad is still
  // hidden on the first attempt, and then every stroke lands offset from the
  // cursor because the two coordinate spaces disagree. Re-checking also covers
  // rotating a phone.
  ensureSize() {
    const rect = this.canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.round(rect.width * dpr)
    const h = Math.round(rect.height * dpr)
    if (this.canvas.width === w && this.canvas.height === h) return

    // Resizing a canvas wipes it, so carry anything already drawn across.
    let previous = null
    if (this.dirty && this.canvas.width && this.canvas.height) {
      previous = document.createElement('canvas')
      previous.width = this.canvas.width
      previous.height = this.canvas.height
      previous.getContext('2d').drawImage(this.canvas, 0, 0)
    }

    this.canvas.width = w
    this.canvas.height = h

    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (previous) ctx.drawImage(previous, 0, 0, rect.width, rect.height)

    this.sized = true
  }

  point(e) {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  start(e) {
    this.ensureSize()
    if (!this.canvas.width || !this.canvas.height) return
    this.canvas.setPointerCapture(e.pointerId)
    this.drawing = true
    this.last = this.point(e)
    // A tap should leave a mark, not nothing.
    this.stroke(this.last, { x: this.last.x + 0.01, y: this.last.y })
  }

  move(e) {
    if (!this.drawing) return
    e.preventDefault()
    const p = this.point(e)
    this.stroke(this.last, p)
    this.last = p
  }

  end(e) {
    if (!this.drawing) return
    this.drawing = false
    this.last = null
    if (this.canvas.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId)
    }
  }

  stroke(from, to) {
    const ctx = this.ctx
    ctx.strokeStyle = this.colour
    ctx.globalAlpha = 0.22

    // Several offset passes rather than one solid line: this is what gives the
    // grainy, uneven edge of a pencil instead of a flat marker stroke.
    for (let i = 0; i < 4; i++) {
      const jx = (Math.random() - 0.5) * 1.5
      const jy = (Math.random() - 0.5) * 1.5
      ctx.lineWidth = 2.1 + Math.random() * 1.1
      ctx.beginPath()
      ctx.moveTo(from.x + jx, from.y + jy)
      ctx.lineTo(to.x + jx, to.y + jy)
      ctx.stroke()
    }

    ctx.globalAlpha = 1
    this.dirty = true
  }

  clear() {
    this.dirty = false
    this.ensureSize()
    const { width, height } = this.canvas
    this.ctx.save()
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.clearRect(0, 0, width, height)
    this.ctx.restore()
  }

  hasDrawing() {
    return this.dirty
  }

  // Transparent PNG, so the note sits on whatever background shows it.
  toBlob() {
    return new Promise((resolve) => {
      if (!this.dirty) return resolve(null)
      this.canvas.toBlob((b) => resolve(b), 'image/png')
    })
  }
}
