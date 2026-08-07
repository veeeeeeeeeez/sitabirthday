// Builds the physical film strip: the perforation column down the left edge,
// and the frames above and below the live one, which are stills from other
// people's submissions so the roll reads as continuous.

import { developStill } from '/film.js'

const reel = document.getElementById('reel')
const perf = document.getElementById('reelPerf')
// Every still frame on the strip, in order, so the roll runs off both edges.
const stills = [...document.querySelectorAll('.frame--still')]

/* ------------------------------------------------------- perforations */

// Super 8 carries exactly one perforation per frame, centred on that frame.
// Measuring the frames is the only way to keep them aligned as the strip
// resizes, and misaligned perfs are the first thing that reads as fake.
function layOutPerforations() {
  const reelBox = reel.getBoundingClientRect()
  if (!reelBox.height) return

  const frames = [...reel.querySelectorAll('.frame')]
  if (!frames.length) return

  const pitch =
    frames.length > 1
      ? frames[1].getBoundingClientRect().top - frames[0].getBoundingClientRect().top
      : frames[0].getBoundingClientRect().height

  const firstCentre =
    frames[0].getBoundingClientRect().top + frames[0].getBoundingClientRect().height / 2 -
    reelBox.top

  perf.textContent = ''
  // Run past both ends so the column never stops short of the strip edge.
  for (let i = -2; i <= frames.length + 2; i++) {
    const y = firstCentre + pitch * i
    if (y < -pitch || y > reelBox.height + pitch) continue
    const hole = document.createElement('span')
    hole.className = 'perf'
    hole.style.top = `${(y / reelBox.height) * 100}%`
    perf.append(hole)
  }
}

layOutPerforations()
addEventListener('resize', layOutPerforations)
// Frame boxes are not final until fonts and layout settle.
requestAnimationFrame(layOutPerforations)
setTimeout(layOutPerforations, 250)

/* ----------------------------------------------------- neighbour frames */

const FALLBACK = [
  '/img/tiles/dale.jpg',
  '/img/tiles/ridge.jpg',
  '/img/tiles/valley.jpg',
  '/img/tiles/coast.jpg',
  '/img/tiles/river.jpg',
]

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Presigned R2 URLs need this for the canvas to stay untainted.
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// Put the neighbours through the same film pipeline so the whole roll matches
// rather than having a graded centre frame between two clean photos.
async function dress(el, src) {
  try {
    const img = await loadImage(src)
    const developed = developStill(img, 480, 360)
    el.style.backgroundImage = `url(${developed || src})`
  } catch {
    // A neighbour frame is decoration; an unreachable one just stays dark.
    el.style.backgroundImage = ''
  }
}

async function fillNeighbours() {
  let frames = []
  try {
    const res = await fetch('/api/reel?limit=8')
    frames = (await res.json()).frames ?? []
  } catch {
    frames = []
  }

  // Before anyone has sent anything the roll would be empty, so fall back to
  // the same photos the tiles use.
  const pool = frames.length >= 2 ? frames : FALLBACK
  const first = Math.floor(Math.random() * pool.length)

  // Walk the pool so neighbouring frames are never the same picture.
  await Promise.all(
    stills.map((el, i) => dress(el, pool[(first + i) % pool.length])),
  )
}

fillNeighbours()

/* --------------------------------------------------------- strip drift */

// The roll creeps very slightly, the way a strip does on a light table.
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let t = 0
  const drift = () => {
    t += 0.006
    reel.style.setProperty('--drift', `${(Math.sin(t) * 0.9).toFixed(2)}px`)
    requestAnimationFrame(drift)
  }
  requestAnimationFrame(drift)
}
