# Known Issues

## Open

### Two-hand detection is unreliable — only one hand tracked at a time

**Reported:** sometimes only one hand lights up / triggers sound, even when
both are clearly in frame.

**Investigation so far:**
- `ml5.handPose()` is configured with `maxHands: 2`, which is also ml5's own
  default — so the request for two hands is correct and was never the issue.
- I reviewed every place a second hand is processed (`hands.forEach`,
  `pinchVolumeScale`, `detectFist`, `collectDesiredSounds`) for anything that
  could throw and silently cut the loop short after the first hand. Found
  nothing — all keypoint lookups are null-guarded.
- I tried lowering ml5's hand-detection/tracking confidence thresholds, but
  those option names (`minHandDetectionConfidence`, `minTrackingConfidence`)
  aren't part of ml5 handPose's option schema — ml5 silently ignores unknown
  options, so that change had no real effect and has been reverted.

**Current best understanding:** this looks like an underlying
ml5/MediaPipe hand-tracking limitation rather than a bug in Weave's own
code — the model can drop the less-clearly-framed of two hands (overlap,
partial occlusion, lighting, distance from camera). It does not appear to
be caused by, or to have started with, any specific commit on this branch —
no code path that runs only for a second hand can throw or otherwise break
detection.

**To make further progress, I need:**
- The browser console output (View → Developer → JavaScript Console in
  Chrome/Safari) while reproducing it — this would show whether ml5 itself
  is only ever returning one hand in `results`, or whether something else is
  happening. I can't reproduce this myself: this environment has no camera
  and can't load the ml5 model from its CDN.
- Whether it happens consistently regardless of how the two hands are
  positioned (side by side vs. overlapping vs. one further from the camera),
  which would help tell a tracking-confidence issue apart from a framing one.

## Resolved

- **Audio freeze after extended use** — see `CHANGELOG.md`.
- **Sound-zone mismatch between visual and audio** — see `CHANGELOG.md`.
- **Camera-dependent fist detection** — see `CHANGELOG.md`.
- **Pinch gesture muting hands in their natural resting pose** — the
  thumb-to-index ratio range was calibrated for a wide spread, so a relaxed
  pointing hand (thumb naturally close to index) read as "half pinched" and
  had its volume quietly capped. Recalibrated the range to match a natural
  pointing pose.
- **Pinch-driven volume changes happening too fast and clicking/crackling
  the audio** — raw per-frame tracking is jittery, and that was being applied
  directly to live audio volume. Now smoothed per-hand over time so volume
  changes gradually, the same way normal point-to-point movement ramps.
