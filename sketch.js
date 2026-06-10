let handPose;
let video;
let hands = [];
let sounds = [];
let activeSounds = new Set();
let soundStopTimers = [];
let fingerHistories = []; // per-hand rolling window of recent fingertip positions, used to detect "fluttering"
let ellipses = [];
let ballToSound = []; // ballToSound[ellipseIndex] -> sound index, indices line up with `ellipses`
let ellipseSpacing = 100;
let baseSize = 50;
let isPaused = true; // Track pause state

// handPose emits results faster than we need to react to; only keeping
// every 3rd frame keeps movement responsive without flooding `hands`
// updates and overworking the gesture/sound logic each frame.
let frameSkip = 3;
let frameCount = 0;

// How close (in canvas px) a fingertip must be to an ellipse to activate it,
// and how far it must move away again to deactivate. Two different radii
// (hysteresis) stop a fingertip sitting near the boundary between two balls
// from rapidly flipping both of them active/inactive ("beaming") — it has to
// commit to leaving before the highlight turns off.
// Tuned by feel against the default ellipseSpacing (100px) and baseSize (50px)
// — small enough that neighboring balls don't activate together.
const ellipseHoverRadius = 100;
const ellipseHoverExitRadius = 140;


// Colors assigned to each sound
const soundColors = [
  [255, 100, 100],   // Red
  [100, 255, 100],   // Green
  [100, 100, 255],   // Blue
  [255, 255, 100],   // Yellow
  [255, 100, 255],   // Magenta
  [100, 255, 255],   // Cyan
  [255, 165, 0],     // Orange
  [128, 0, 128],     // Purple
  [0, 255, 127],     // Spring Green
  [70, 130, 180],    // Steel Blue
  [255, 182, 193],   // Light Pink
  [240, 230, 140]    // Khaki
];

function preload() {
  // maxHands: 2 is ml5's own default, kept explicit since Weave's whole
  // "two hands conducting" idea depends on both being seen. (Tried lowering
  // ml5's detection/tracking confidence thresholds here too, but those
  // option names aren't part of ml5 handPose's schema — they're silently
  // ignored — so that wasn't actually doing anything. See KNOWN_ISSUES.md
  // for the open two-hand-detection report.)
  handPose = ml5.handPose({ maxHands: 2 });

  // Load 12 Sounds
  sounds.push(loadSound('Sounds/mixkit-angelic-drum-roll-573.wav'));
  sounds.push(loadSound('Sounds/mixkit-brass-stick-2288.wav'));
  sounds.push(loadSound('Sounds/mixkit-cinematic-angelical-choir-transition-663.wav'));
  sounds.push(loadSound('Sounds/mixkit-cinematic-drama-riser-632.wav'));
  sounds.push(loadSound('Sounds/mixkit-heavenly-swell-2674.wav'));
  sounds.push(loadSound('Sounds/mixkit-medieval-orchestra-announcement-694.wav'));
  sounds.push(loadSound('Sounds/mixkit-mysterious-long-swell-2671.wav'));
  sounds.push(loadSound('Sounds/mixkit-trumpets-and-strings-off-beat-2286.wav'));
  sounds.push(loadSound('Sounds/mixkit-trumpet-fanfare-2293.wav'));
  sounds.push(loadSound('Sounds/mixkit-threatening-orchestra-trumpets-2284.wav'));
  sounds.push(loadSound('Sounds/mixkit-orchestra-happy-fast-jingle-696.wav'));
  sounds.push(loadSound('Sounds/mixkit-mythical-violin-jingle-2281.wav'));
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  createEllipses();
  assignBallsToSounds();
  video = createCapture(VIDEO);
  video.size(width, height);
  video.hide();
  handPose.detectStart(video, gotHands);
}

function draw() {
  background(30);

  // Show paused screen if paused
  if (isPaused) {
    drawPausedScreen();
    return;
  }

  drawEllipses();

  if (hands.length === 0) {
    resetEllipses();
    stopAllSounds();
    fingerHistories = []; // stale positions shouldn't trigger a false flutter when hands return
    return;
  }

  // soundIndex -> { volume, ramp }. Built up across all hands, then applied
  // in one pass — so e.g. a fluttering hand's tremolo on a zone isn't
  // overridden by another hand simply pointing at the same zone.
  let desiredSounds = new Map();

  // A clenched fist curls the thumb and index fingertip close together —
  // which, left unchecked, also reads as a deliberate pinch and pops up the
  // volume HUD right as the fist gesture is stopping the sound. Skip the
  // pinch-volume update entirely while any hand is fisted, so making a fist
  // is just a clean fade-out with no extra volume-change feedback.
  let fistFlags = hands.map(detectFist);
  let volumeScale = smoothedGlobalPinchVolume;
  if (!fistFlags.some(isFist => isFist)) {
    volumeScale = updateGlobalPinchVolume(hands); // both hands pinching = quieter, smoothed
    noteVolumeForHud(volumeScale);
  }

  hands.forEach((hand, handIndex) => {
    let indexTip = hand.keypoints.find(k => k.name === 'index_finger_tip');
    if (indexTip) {
      let flippedX = width - indexTip.x; // Flip the x-axis for natural interaction
      animateEllipses(flippedX, indexTip.y);
      collectDesiredSounds(handIndex, flippedX, indexTip.y, volumeScale, desiredSounds);
    } else {
      fingerHistories[handIndex] = null; // no fingertip this frame — don't carry stale flutter history
    }

    // Detect fist gesture
    if (fistFlags[handIndex]) {
      stopAllSounds(); // Stop all sounds (fades out, see scheduleStop)
      resetEllipses(); // Reset ellipses to default state
      desiredSounds.clear(); // a fist overrides whatever the hand was just doing
    }
  });

  syncActiveSounds(desiredSounds);
  drawVolumeHud();
}

// Distance between wrist and middle-knuckle, used as a per-hand "ruler" so
// gesture thresholds (fist, pinch) scale with how big the hand appears —
// which varies with camera resolution, lens, and distance from the lens —
// instead of relying on fixed pixel values tuned to one specific setup.
function handScale(hand) {
  let wrist = hand.keypoints.find(k => k.name === 'wrist');
  let middleKnuckle = hand.keypoints.find(k => k.name === 'middle_finger_mcp');
  if (!wrist || !middleKnuckle) return 0;
  return dist(wrist.x, wrist.y, middleKnuckle.x, middleKnuckle.y);
}

function detectFist(hand) {
  let wrist = hand.keypoints.find(k => k.name === 'wrist');
  let scale = handScale(hand);
  if (!wrist || scale === 0) return false;

  let closedThreshold = scale * 1.3;
  let fingertips = ['thumb_tip', 'index_finger_tip', 'middle_finger_tip', 'ring_finger_tip', 'pinky_tip'];

  for (let tip of fingertips) {
    let fingertip = hand.keypoints.find(k => k.name === tip);
    if (fingertip) {
      let distance = dist(fingertip.x, fingertip.y, wrist.x, wrist.y);
      if (distance > closedThreshold) {
        return false; // If any fingertip is far from the wrist, it's not a fist
      }
    }
  }
  return true; // All fingertips are close to the wrist, so it's a fist
}

// Pinching with both hands at once (thumb and index finger drawing together
// on each hand) controls volume — pinched = quiet, spread open = full
// volume. The thumb-to-index distance is measured relative to handScale() so
// it adapts across cameras/distances, the same way fist detection does.
// Note: in a natural pointing pose (the sketch's primary gesture), the thumb
// rests fairly close to the index finger — its ratio sits well below 1.0.
// The old 0.4–1.4 range treated that resting pose as "half pinched," quietly
// dragging volume down on any hand that wasn't deliberately spread wide open
// (which read as "barely detecting" that hand). Shifted the range down so a
// relaxed pointing hand lands near full volume, and only a deliberate pinch
// (thumb and index actually touching) lowers it.
const pinchClosedRatio = 0.12; // thumb-to-index distance / handScale when "closed"
const pinchOpenRatio = 0.55;   // ...when "open" (relaxed pointing pose, not a wide spread)
const pinchMinVolume = 0.15;  // never fully mute via pinch — keep some presence
const pinchMaxVolume = 1.0;

// Raw frame-to-frame hand tracking is jittery, and the volume this drives
// gets applied to already-playing audio — so following it directly made the
// volume jump around fast enough to click/crackle the sound. Smoothing the
// value toward its target over time turns that into a gradual fade, the same
// way normal point-to-point movement already ramps with `ramp`.
const pinchSmoothingFactor = 0.06; // lower = slower, gentler volume changes

// Volume is a single shared value, only adjusted while BOTH hands are visible
// and both are pinching (thumb and index together on each hand). A single
// hand pinching alone — which happens constantly just from pointing at a
// ball — no longer touches volume; it now takes a deliberate two-handed
// "squeeze" on both sides at once. When fewer than two hands are tracked, or
// either hand's pinch can't be measured, volume just holds at its last value.
let smoothedGlobalPinchVolume = pinchMaxVolume;

// Thumb-to-index distance / handScale, or null if this hand's pinch can't be
// measured (missing keypoints / zero scale).
function pinchRatio(hand) {
  let thumbTip = hand.keypoints.find(k => k.name === 'thumb_tip');
  let indexTip = hand.keypoints.find(k => k.name === 'index_finger_tip');
  let scale = handScale(hand);
  if (!thumbTip || !indexTip || scale === 0) return null;
  return dist(thumbTip.x, thumbTip.y, indexTip.x, indexTip.y) / scale;
}

function updateGlobalPinchVolume(hands) {
  if (hands.length >= 2) {
    let ratios = hands.map(pinchRatio);
    if (ratios.every(r => r !== null)) {
      let avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      let clamped = constrain(avgRatio, pinchClosedRatio, pinchOpenRatio);
      let target = map(clamped, pinchClosedRatio, pinchOpenRatio, pinchMinVolume, pinchMaxVolume);
      smoothedGlobalPinchVolume = lerp(smoothedGlobalPinchVolume, target, pinchSmoothingFactor);
    }
  }
  return smoothedGlobalPinchVolume;
}

// Visual feedback for the pinch gesture, styled after the macOS volume HUD:
// a rounded pill of segmented bars, fixed at the top-center of the screen —
// deliberately NOT attached to the hand, so it never overlaps or competes
// with the moving balls. It only appears while the volume is actively being
// changed (like the Mac HUD appearing on a key press) and fades out shortly
// after the hand stops adjusting it, so it's never just sitting there as
// visual noise.
const hudSegmentCount = 10;
const hudVisibleMs = 900;
const hudChangeThreshold = 0.01;

let hudLastVolume = null;
let hudVisibleUntil = 0;

function noteVolumeForHud(volumeScale) {
  if (hudLastVolume !== null && abs(volumeScale - hudLastVolume) > hudChangeThreshold) {
    hudVisibleUntil = millis() + hudVisibleMs;
  }
  hudLastVolume = volumeScale;
}

function drawVolumeHud() {
  if (millis() > hudVisibleUntil || hudLastVolume === null) return;

  let pillW = 200;
  let pillH = 56;
  let pillX = width / 2 - pillW / 2;
  let pillY = 30;

  noStroke();
  fill(40, 40, 40, 200);
  rect(pillX, pillY, pillW, pillH, pillH / 2);

  let segmentGap = 4;
  let segmentWidth = (pillW - 40 - segmentGap * (hudSegmentCount - 1)) / hudSegmentCount;
  let segmentHeight = 16;
  let startX = pillX + 20;
  let segmentY = pillY + (pillH - segmentHeight) / 2;
  let litCount = round(map(hudLastVolume, pinchMinVolume, pinchMaxVolume, 0, hudSegmentCount));

  for (let i = 0; i < hudSegmentCount; i++) {
    fill(i < litCount ? color(255, 255, 255, 230) : color(255, 255, 255, 60));
    rect(startX + i * (segmentWidth + segmentGap), segmentY, segmentWidth, segmentHeight, 2);
  }
}

// ml5 occasionally reports zero hands for a single detection cycle even
// though a hand is still clearly in frame — a brief tracking blip, not the
// hand actually leaving. Without smoothing this over, that one blip hits the
// `hands.length === 0` branch in draw(), which immediately stops all sounds
// and resets the ellipse grid — i.e. everything visibly "disappears" and
// resets for an instant. Riding through a few consecutive empty results
// before treating the hands as actually gone bridges these blips.
const noHandsGraceCycles = 5;
let noHandsStreak = 0;

function gotHands(results) {
  if (!isPaused && frameCount % frameSkip === 0) {
    if (results.length > 0) {
      hands = results;
      noHandsStreak = 0;
    } else if (hands.length > 0 && noHandsStreak < noHandsGraceCycles) {
      noHandsStreak++; // brief blip — keep using the last known hands
    } else {
      hands = results; // confirmed empty
    }
  }
  frameCount++; // Increase the frame count on every call
}

function createEllipses() {
  for (let x = ellipseSpacing / 2; x < width; x += ellipseSpacing) {
    for (let y = ellipseSpacing / 2; y < height; y += ellipseSpacing) {
      let ellipseProps = {
        x: x,
        y: y,
        size: baseSize,
        originalSize: baseSize,
        expandedSize: baseSize + 25,
        color: [255, 255, 255], // Default white
        targetColor: [255, 255, 255], // Target for smooth transitions
        isActive: false,
      };
      ellipses.push(ellipseProps);
    }
  }
}

function assignBallsToSounds() {
  // Assign each ellipse to whichever sound its grid position maps to, so the
  // ball that lights up always matches the sound that plays there.
  ballToSound = ellipses.map((ellipseProps) => soundIndexForPosition(ellipseProps.x, ellipseProps.y));
}


function drawEllipses() {
  noStroke();
  for (let ellipseProps of ellipses) {
    // Smoothly transition to target colors and sizes.
    // Lower factor (0.1) = slower color fade, higher (0.2) = snappier size
    // change — tuned by feel so the highlight feels responsive but not jarring.
    ellipseProps.color[0] = lerp(ellipseProps.color[0], ellipseProps.targetColor[0], 0.1);
    ellipseProps.color[1] = lerp(ellipseProps.color[1], ellipseProps.targetColor[1], 0.1);
    ellipseProps.color[2] = lerp(ellipseProps.color[2], ellipseProps.targetColor[2], 0.1);

    fill(...ellipseProps.color);
    let targetSize = ellipseProps.isActive ? ellipseProps.expandedSize : ellipseProps.originalSize;
    ellipseProps.size = lerp(ellipseProps.size, targetSize, 0.2);
    ellipse(ellipseProps.x, ellipseProps.y, ellipseProps.size, ellipseProps.size);
  }
}

function drawPausedScreen() {
  background (204, 255, 255)
  textAlign(CENTER, CENTER);
  fill(34,139,34);
  textSize(90);
  textFont ('HWT Arabesque');
  text('Press the "Space bar" to start', width / 2, height / 2);
}

function animateEllipses(handX, handY) {
  for (let i = 0; i < ellipses.length; i++) {
    let ellipseProps = ellipses[i];
    let distance = dist(handX, handY, ellipseProps.x, ellipseProps.y);

    if (distance < ellipseHoverRadius) {
      ellipseProps.isActive = true;
      ellipseProps.targetColor = soundColors[ballToSound[i]]; // Highlight active ball
    } else if (distance > ellipseHoverExitRadius && !isAnyHandNear(ellipseProps.x, ellipseProps.y)) {
      ellipseProps.isActive = false;
      ellipseProps.targetColor = [255, 255, 255]; // Reset to white
    }
  }
}

function isAnyHandNear(x, y) {
  for (let hand of hands) {
    let indexTip = hand.keypoints.find(k => k.name === 'index_finger_tip');
    if (indexTip) {
      let flippedX = width - indexTip.x;
      let distance = dist(flippedX, indexTip.y, x, y);
      if (distance < ellipseHoverExitRadius) {
        return true;
      }
    }
  }
  return false;
}

// Sounds are laid out across a 2D grid of zones (columns x rows) rather
// than sliced along a single axis — people naturally gesture across both
// width and height, so spreading sounds over both makes every one of them
// reachable through normal movement instead of clustering around whichever
// horizontal band a hand happens to sweep through.
const soundGridCols = 4;

// Single source of truth for "which sound zone is this position in" — used
// both to trigger sounds and to decide which sounds should keep playing
// (and to color the ellipse grid), so all three never disagree.
// `sounds` is only populated once preload() runs, so rows are computed
// here rather than at script-load time when `sounds` would still be empty.
function soundIndexForPosition(x, y) {
  let soundGridRows = Math.ceil(sounds.length / soundGridCols);
  let col = constrain(floor(map(x, 0, width, 0, soundGridCols)), 0, soundGridCols - 1);
  let row = constrain(floor(map(y, 0, height, 0, soundGridRows)), 0, soundGridRows - 1);
  let soundIndex = row * soundGridCols + col;
  return constrain(soundIndex, 0, sounds.length - 1);
}

function cancelStopTimer(soundIndex) {
  if (soundStopTimers[soundIndex]) {
    clearTimeout(soundStopTimers[soundIndex]);
    soundStopTimers[soundIndex] = null;
  }
}

// "Fluttering" — quickly wagging fingers back and forth in a small area —
// is a gesture people do naturally and instinctively. Rather than try to
// reuse it for switching/blending sounds (the sketch already crossfades
// between sounds as a hand moves, so a "blend" effect wasn't distinguishable
// from normal movement), we map it onto a tremolo: a rapid, rhythmic volume
// wobble on whatever sound is currently playing. The faster the flutter, the
// faster the wobble — a direct, physical link between the gesture and what
// you hear, the same way a violinist's wrist motion becomes vibrato.
//
// Detected via a short rolling window of recent fingertip positions: a
// flutter covers a long, winding path but ends up roughly where it started
// (high path-to-net-displacement ratio), unlike a deliberate point-and-move
// which travels in roughly one direction.
const flutterHistoryLength = 15;
const flutterMinPathLength = 60; // px — ignore tiny jitter from a still hand
const flutterPathToDisplacementRatio = 2.2;

// Faster fluttering (more px traveled in the same window) => faster wobble.
const tremoloMinRateHz = 4;
const tremoloMaxRateHz = 12;
const tremoloMaxPathLength = 400; // path length that maps to the fastest wobble
const tremoloDepth = 0.4; // volume swings between (1 - depth) and 1

function recordFingerPosition(handIndex, x, y) {
  let history = fingerHistories[handIndex] || [];
  history.push({ x, y });
  if (history.length > flutterHistoryLength) history.shift();
  fingerHistories[handIndex] = history;
  return history;
}

// Returns the recent path length if this history looks like a flutter, or
// null if the hand is just moving normally (or sitting still).
function flutterPathLength(history) {
  if (history.length < flutterHistoryLength) return null;

  let pathLength = 0;
  for (let i = 1; i < history.length; i++) {
    pathLength += dist(history[i - 1].x, history[i - 1].y, history[i].x, history[i].y);
  }
  if (pathLength < flutterMinPathLength) return null; // hand is basically still

  let netDisplacement = dist(
    history[0].x, history[0].y,
    history[history.length - 1].x, history[history.length - 1].y
  );
  let isFlutter = pathLength / max(netDisplacement, 1) > flutterPathToDisplacementRatio;
  return isFlutter ? pathLength : null;
}

// A continuous volume oscillation (LFO) whose speed scales with flutter
// intensity. Using millis() (not frameCount) keeps the wobble's real-world
// speed consistent regardless of frame rate.
function tremoloVolume(pathLength, ceiling) {
  let rateHz = map(constrain(pathLength, flutterMinPathLength, tremoloMaxPathLength),
                   flutterMinPathLength, tremoloMaxPathLength,
                   tremoloMinRateHz, tremoloMaxRateHz);
  let lfo = sin((millis() / 1000) * rateHz * TWO_PI); // oscillates -1..1
  return ceiling - tremoloDepth / 2 + (tremoloDepth / 2) * lfo; // wobbles just under the pinch ceiling
}

// Figures out what one hand wants to hear right now and merges it into the
// shared desiredSounds map. `ramp` is how long setVolume should take to reach
// the target — tremolo needs near-instant updates each frame so the wobble is
// actually audible; normal movement gets a smooth ramp to avoid clicks.
// `volumeScale` is the pinch-controlled ceiling (1.0 = full volume, lower =
// pinched quieter) — both normal playback and tremolo respect it.
function collectDesiredSounds(handIndex, x, y, volumeScale, desiredSounds) {
  let history = recordFingerPosition(handIndex, x, y);
  let zone = soundIndexForPosition(x, y);
  let pathLength = flutterPathLength(history);

  if (pathLength !== null) {
    desiredSounds.set(zone, { volume: tremoloVolume(pathLength, volumeScale), ramp: 0 });
  } else if (!desiredSounds.has(zone) || desiredSounds.get(zone).ramp === 0) {
    // Don't let a plain point override another hand's tremolo on the same zone
    desiredSounds.set(zone, { volume: volumeScale, ramp: 0.15 });
  }
}

// Brings actual sound playback in line with what the hands currently want:
// starts/raises anything newly desired, fades out anything no longer wanted.
function syncActiveSounds(desiredSounds) {
  desiredSounds.forEach(({ volume, ramp }, soundIndex) => {
    cancelStopTimer(soundIndex); // still wanted — don't let a queued stop kill it

    if (!activeSounds.has(soundIndex)) {
      activeSounds.add(soundIndex);
      if (!sounds[soundIndex].isPlaying()) {
        sounds[soundIndex].loop();
      }
    }
    sounds[soundIndex].setVolume(volume, ramp);
  });

  // Copy to an array first — scheduleStop mutates activeSounds asynchronously,
  // and mutating a Set while iterating it is asking for trouble.
  for (let soundIndex of [...activeSounds]) {
    if (!desiredSounds.has(soundIndex) && !soundStopTimers[soundIndex]) {
      scheduleStop(soundIndex);
    }
  }
}

function scheduleStop(soundIndex) {
  cancelStopTimer(soundIndex); // never stack timers for the same sound

  // Fade out over 500ms, then actually stop once the fade completes —
  // avoids an abrupt cutoff when a hand leaves a sound's zone. The
  // setTimeout duration must match the fade duration passed to setVolume.
  let fadeDurationMs = 500;
  sounds[soundIndex].setVolume(0, fadeDurationMs / 1000);
  soundStopTimers[soundIndex] = setTimeout(() => {
    sounds[soundIndex].stop();
    activeSounds.delete(soundIndex);
    soundStopTimers[soundIndex] = null;
  }, fadeDurationMs);
}

function stopAllSounds() {
  for (let soundIndex of [...activeSounds]) {
    scheduleStop(soundIndex);
  }
}

function resetEllipses() {
  for (let ellipseProps of ellipses) {
    ellipseProps.isActive = false;
    ellipseProps.targetColor = [255, 255, 255]; // Reset to white
  }
}

// Toggle pause and resume
function keyPressed() {
  if (key === ' ') {
    isPaused = !isPaused; // Toggle pause state
    if (isPaused) {
      stopAllSounds(); // Stop sounds immediately when paused
    }
  }
}