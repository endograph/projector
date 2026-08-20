# projector landing — working notes

A design mock, not shipping code. Built on the sidecar marketing template
(`~/dev/sidecar/packages/marketing`) with two things swapped: the hero graphic
(nesting → projection) and the lighting.

## Run it

```
npm run dev        # http://127.0.0.1:4321/  — live reload, survives the terminal closing
```

`scripts/serve-site.mjs` is sidecar's server, verbatim except the default root
(`.` instead of `site/`, since this mock is flat).

- `/` — the page
- `/compare.html` — every variant stacked, scroll-synced, `1`–`3` / `j` / `k` to move
- `/?variant=f2` — a single variant; picker in the bottom-right corner

## The concept

sidecar's mark is "nested" because sidecar is a child inside a parent.
projector's is **refraction**: one white beam in, a spectrum of per-actor views
out. Two independent systems express it:

1. **The ray** — a fixed SVG that tracks whatever the page wants read next.
2. **The wash** — the muted spectrum on the right, dispersed from the lit element.

The hero diagram (`.fan`) is the same idea at small scale: `state` → lens →
`user` / `agent` / `replay`. The ray's default resting target is that lens, so
the page's light feeds the diagram's own projector.

## Architecture

- `index.html` — markup, the `.light` SVG (two polygons: `l-glow`, `l-core`),
  and the tracker script at the end of `<body>`. The tracker is the only
  moving part: one rAF loop, ~150 lines.
- `style.css` — everything painterly. Variant blocks near the bottom.
- `variants.js` — the picker + `VARIANTS` list. Scratch tooling.
- `archive/variants-a-e.css` — retired explorations, unlinked.

### Targeting hierarchy (tracker)

1. **hover** on any `a`/`button` (mouse only — `pointerType` filters touch)
2. **keyboard focus** — the beam doubles as a focus indicator
3. **text selection** — declined above 55% of viewport height (select-all has
   no meaningful centre; the beam holds its previous target instead)
4. **sticky** — the last interaction target persists until you *scroll*.
   Falling off a hover does not release it. This was deliberate; without it
   the beam twitched constantly.
5. **reading order** — nearest candidate above the viewport midline. Candidates
   are only the lens and the three CTA cards. Off-screen elements are
   ineligible, which is what stops the beam pointing at nothing during fast
   scrolls.
6. **resting spot** — viewport centre at the column edge when nothing qualifies.

### Scroll locking

The `.light` SVG is `position: absolute` sized to the document, and the focus
band is written in **document coordinates**. While locked, those are constants,
so the beam rides the compositor with the content — a dropped main-thread frame
can't make it trail. Only the source aperture (genuinely viewport-anchored) is
recomputed per frame, and it's the wide blurred end where a frame of lag can't
be seen. Don't "simplify" this back to `position: fixed`; that was the lag.

Easing applies **only to retargets** (18%/frame lerp). Load-in is linear —
light doesn't decelerate.

### Modes

| | wide (≥1150px) | narrow |
|---|---|---|
| shape | pool washes across the whole element | band stops at the **layout's** left edge |
| angle | diagonal from mid-left | level |
| exception | — | the lens projects into the page anyway |

Narrow mode ends at `main`'s content edge, **not** the target's left edge —
deriving it from the target sent the band across the text whenever the target
sat mid-column (the lens especially). Height still comes from the target, so
it stays a marker for the current element.

## Hard-won gotchas

Roughly in order of how long each cost.

- **Custom-property substitution is scoped to where the property is
  *declared*.** `--sweep` lived on `:root` and referenced `--wash-wipe`, so it
  resolved against `:root`'s value and inherited down as a frozen string —
  animating `--wash-wipe` on `.wash` did nothing. A variable must be *used* on
  the element that animates it. `--wedge` / `--from-target` work only because
  both they and `--fx`/`--fy` live on `:root`; moving `--fx` to a child would
  break them the same way.
- **`var()` inside `@keyframes` doesn't reliably resolve** for a registered
  property. Keep keyframes literal (`0px → 135vw`) and put any offset in the
  consuming `calc()`.
- **Three mask layers composited with `intersect` rendered nothing.** Fixed by
  splitting the job across two nested elements — `.wash` (sweep) and `.wash i`
  (shaping) — one mask job each. Also dropped `-webkit-mask-composite`, which
  takes a different keyword set and disagreed with the standard property.
  Whenever the wash goes invisible, suspect the masks before the colours.
- **Blur kernel vs shape size.** A gaussian is a fixed physical size, so on a
  shape not much thicker than the kernel it destroys *peak* alpha instead of
  softening edges. Every mode therefore has its own filters and opacities
  (`ray-*`, `ray-*-h`, `ray-*-spot`, `ray-*-spot-h`). If a new mode looks
  mysteriously washed out, this is why.
- **Mach banding.** A piecewise-linear mask falloff whose steepest segment sits
  at the leading edge reads as a *bright line* — the eye manufactures an edge
  wherever the gradient's slope jumps. The wipe now uses smoothstep-shaped
  stops (flat, steep, flat). Other fixes if it returns: blur the mask layer,
  dither it, or shorten the tail.
- **White on paper tops out at ~10 RGB units.** Light mode can't render a white
  beam on a white page, which is why `--bg` is warm gray and the beam is
  two-tone (`--ray-body` white core, `--ray-edge` dark boundary). Dark mode
  collapses both vars to white.

## Tuning knobs

- **Beam brightness** — `.light .l-glow` / `.l-core` opacity, per mode. The
  gradient stops (`#ray-grad-*`) shape the profile along its length; layer
  opacity is the master.
- **Size compensation** — in the tracker: `Math.pow(0.0108 / frac, 0.7)`
  clamped `[0.3, 1]`. Normalises apparent brightness against lit *area*
  (shoelace, as a fraction of the viewport). The exponent controls how much
  size matters; the floor stops big text selections fading toward nothing.
  Full inverse-area (exponent 1) is physically right but perceptually wrong at
  both ends — don't "correct" it back.
- **Load-in** — `SPEED` (px/ms) drives both the beam reach and the wash sweep;
  durations are derived from distance so the front never changes pace and the
  whole sequence scales with viewport width. `INTRO_DELAY`, `WASH_AT`.
- **Wash sweep vs fade** — the `wash-fade` `from` opacity and its duration
  multiplier. Fade-forward feels ambient, sweep-forward feels directional;
  currently ~0.16 / 0.9× sits just on the sweep side.
- **Wash** — `--spec-a` per theme; hues `--spec-r`…`--spec-v`.

## Open / next

- The lens's exemptions (exact height, projects into the page on narrow) all
  key off one identity check, `locked === lensEl`. Keep it that way.
- f1 / f2 / f3 are still live options — f1 keeps the wash where it always was,
  f2 starts it at the target, f3 makes the hues radiate. No decision yet.
- Not started: real logo art (the lamp glyph is a placeholder), og image,
  favicon, the actual doc links, `stamp-stars`.
- The wash sweep repaints a full-screen masked layer. Fine as a one-shot on
  load; if it ever re-runs per retarget, that's the first frame-rate problem.
- Verified structurally throughout (geometry math, CSS validity) but the
  browser preview MCP lost its token partway, so late changes were never seen
  rendered by me — trust the screenshots over my descriptions.
