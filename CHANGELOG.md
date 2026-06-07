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
- **Added "flutter as tremolo" gesture** — quickly wagging fingers back and
  forth (something many people did instinctively) is now detected and mapped
  to a tremolo effect: a rapid volume wobble on the active sound, with the
  wobble's speed scaling with how fast the flutter is. (An earlier version of
  this mapped flutter to "blend nearby sounds," but since the sketch already
  crossfades between sounds during normal movement, that effect wasn't
  perceptibly different — tremolo gives the gesture a distinct, audible
  identity tied directly to the physical motion.)
- **Added pinch-to-control-volume gesture** — bringing thumb and index
  finger together now lowers volume; spreading them raises it. Measured as
  a ratio against the hand's own size (the same scale-adaptive "ruler" used
  for fist detection), so it works consistently across different cameras and
  distances rather than relying on fixed pixel thresholds. This acts as a
  live ceiling that both normal sound playback and the flutter/tremolo
  effect respect — pinching down softens a tremolo too, not just a sustained
  note.

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
