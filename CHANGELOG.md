# Changelog

All notable changes made on the `weave-improvements` branch are documented here.

## Bug fixes

- **Fixed audio freeze after extended use** — sound stop/fade timers were
  stacking up every frame a hand drifted in and out of a sound's zone,
  eventually overwhelming the audio engine. Each sound now has exactly one
  tracked stop-timer that gets cancelled and rescheduled cleanly.
- **Fixed sound-zone mismatch** — the ball that lit up and the sound that
  played were calculated by two slightly different formulas, so they could
  disagree, and some sounds occupied uneven slices of the screen. Both now
  derive from a single shared mapping function.
- **Fixed inconsistent fist-detection across cameras/laptops** — the
  "make a fist to stop sounds" gesture used a fixed pixel distance that only
  worked at the original camera's distance/resolution. It now scales with
  the size of the detected hand itself, so it travels with you across setups.

## Interaction changes

- **Redesigned sound-zone layout from 1D to a 2D grid** — sounds used to be
  sliced side-by-side along the screen's width only, so people only ever
  triggered the handful of sounds overlapping their natural horizontal
  movement range. Sounds are now spread across a 4-column x 3-row grid, so
  every sound is reachable through normal up/down/left/right movement.
- **Added "flutter to blend" gesture** — quickly wagging fingers back and
  forth (something many people did instinctively, seemingly trying to mix
  sounds) is now detected and used to layer up to 3 nearby sounds together
  at a softened volume, rather than abruptly switching between them.

## Code cleanup

- Converted `ballToSound` from an object to an array (it's always indexed
  in lockstep with the ellipses array).
- Replaced duplicated "max distance" magic numbers with a single named
  constant.
- Added comments explaining "tuned by feel" constants (frame-skip rate,
  hover radius, lerp factors, fade duration) for future reference.
- Removed committed `.DS_Store` files and added a `.gitignore`.

## Documentation

- Added `EXPERIENCE_IDEAS.md` — a running list of design/interaction
  directions discussed for future iterations (gesture vocabulary, visual
  design, onboarding, accessibility, etc.).
