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

// Fist hold — must be sustained for FIST_CONFIRM_FRAMES consecutive frames
// before stopping all sounds. Filters out natural hand-close motions (~200ms)
// while still feeling like a conductor's deliberate hold (~2s).
const FIST_CONFIRM_FRAMES = 20; // ~2s at 10fps effective (frameSkip=3 @ 30fps)
const FIST_COOLDOWN_MS = 3000;
let fistFrameCount = 0;
let lastFistFireTime = 0;

// Discrete pinch-to-volume: thumb actually touching index = one pinch event.
// Double pinch within window = volume down one step; triple = volume up one step.
// Uses a tight contact threshold (actual touch, not proximity drift) to avoid
// accidental triggers during normal hand movement.
const PINCH_CONTACT_RATIO  = 0.18; // thumb-tip to index-tip / handScale — actual contact
const PINCH_RELEASE_RATIO  = 0.35; // must rise above this to count as released
const PINCH_WINDOW_MS      = 2000; // double/triple pinch must complete within this window
const VOLUME_STEPS         = [0.2, 0.4, 0.6, 0.8, 1.0];
let currentVolumeStep      = 4;    // start at full volume (index into VOLUME_STEPS)
let pinchState             = [];   // per hand: 'open' | 'contact'
let pinchTapTimes          = [];   // timestamps of recent completed pinch events (across all hands)

// How close (in canvas px) a fingertip must be to an ellipse to activate it.
// Tuned by feel against the default ellipseSpacing (100px) and baseSize (50px)
// — small enough that neighboring balls don't activate together.
const ellipseHoverRadius = 100;


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

  hands.forEach((hand, handIndex) => {
    let indexTip = hand.keypoints.find(k => k.name === 'index_finger_tip');
    if (indexTip) {
      let flippedX = width - indexTip.x;
      animateEllipses(flippedX, indexTip.y);
      updatePinchTaps(hand, handIndex);
      let volumeScale = VOLUME_STEPS[currentVolumeStep];
      noteVolumeForHud(volumeScale);
      collectDesiredSounds(handIndex, flippedX, indexTip.y, volumeScale, desiredSounds);
    } else {
      fingerHistories[handIndex] = null;
    }
  });

  // Fist hold: fires once after sustained hold, stops everything
  if (updateFistAndShouldFire(hands)) {
    stopAllSounds();
    resetEllipses();
    desiredSounds.clear();
  }

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

// Detects deliberate thumb-to-index pinch events (actual contact, not proximity
// drift). Double pinch within PINCH_WINDOW_MS = volume down; triple = volume up.
// The tight PINCH_CONTACT_RATIO threshold (actual touch) means fingers casually
// drifting near each other during movement won't register as a pinch.
function updatePinchTaps(hand, handIndex) {
  let thumbTip  = hand.keypoints.find(k => k.name === 'thumb_tip');
  let indexTip  = hand.keypoints.find(k => k.name === 'index_finger_tip');
  let scale     = handScale(hand);
  if (!thumbTip || !indexTip || scale === 0) return;

  let ratio    = dist(thumbTip.x, thumbTip.y, indexTip.x, indexTip.y) / scale;
  let prevState = pinchState[handIndex] || 'open';

  if (prevState === 'open' && ratio < PINCH_CONTACT_RATIO) {
    // Transition: open → contact — record a tap
    pinchState[handIndex] = 'contact';
    pinchTapTimes.push(millis());

    // Prune taps outside the window
    let now = millis();
    pinchTapTimes = pinchTapTimes.filter(t => now - t < PINCH_WINDOW_MS);

    if (pinchTapTimes.length === 2) {
      currentVolumeStep = max(0, currentVolumeStep - 1); // double pinch → volume down
      pinchTapTimes = [];
    } else if (pinchTapTimes.length >= 3) {
      currentVolumeStep = min(VOLUME_STEPS.length - 1, currentVolumeStep + 1); // triple → up
      pinchTapTimes = [];
    }
  } else if (prevState === 'contact' && ratio > PINCH_RELEASE_RATIO) {
    pinchState[handIndex] = 'open';
  }
}

function isFistShape(hand) {
  let wrist = hand.keypoints.find(k => k.name === 'wrist');
  let scale = handScale(hand);
  if (!wrist || scale === 0) return false;
  let closedThreshold = scale * 1.3;
  let fingertips = ['thumb_tip', 'index_finger_tip', 'middle_finger_tip', 'ring_finger_tip', 'pinky_tip'];
  for (let tip of fingertips) {
    let fingertip = hand.keypoints.find(k => k.name === tip);
    if (fingertip && dist(fingertip.x, fingertip.y, wrist.x, wrist.y) > closedThreshold) return false;
  }
  return true;
}

// Returns true once: the frame the sustained fist hold completes.
// Requires FIST_CONFIRM_FRAMES consecutive fist-shape frames so natural
// hand-close motions (200–400ms) never fire — only a deliberate conductor hold.
function updateFistAndShouldFire(hands) {
  let anyFist = hands.some(h => isFistShape(h));
  if (anyFist) {
    fistFrameCount++;
    if (fistFrameCount === FIST_CONFIRM_FRAMES && millis() - lastFistFireTime > FIST_COOLDOWN_MS) {
      lastFistFireTime = millis();
      return true;
    }
  } else {
    fistFrameCount = 0;
  }
  return false;
}

// pinchMinVolume kept for the HUD mapper — the actual volume ceiling now comes
// from VOLUME_STEPS[currentVolumeStep] set by discrete pinch events.
const pinchMinVolume = VOLUME_STEPS[0];
const pinchMaxVolume = VOLUME_STEPS[VOLUME_STEPS.length - 1];

// Unused — kept so noteVolumeForHud callers don't break.
function pinchVolumeScale() {
  return VOLUME_STEPS[currentVolumeStep];
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

function gotHands(results) {
  if (!isPaused && frameCount % frameSkip === 0) {
    hands = results;
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
  background(204, 255, 255);
  textFont('HWT Arabesque');
  textAlign(CENTER, CENTER);

  // Title
  fill(34, 139, 34);
  textSize(110);
  text('WEAVE', width / 2, height * 0.13);

  // Subtitle
  textSize(38);
  fill(20, 100, 20);
  text('An interactive sound installation', width / 2, height * 0.22);

  // Divider
  stroke(34, 139, 34, 120);
  strokeWeight(2);
  line(width * 0.2, height * 0.28, width * 0.8, height * 0.28);
  noStroke();

  // Gesture instructions
  fill(20, 100, 20);
  textSize(34);
  textAlign(LEFT, TOP);

  let col1 = width * 0.15;
  let col2 = width * 0.55;
  let rowH  = height * 0.11;
  let startY = height * 0.33;

  // Left column
  text('☞  Point your finger', col1, startY);
  text('✊  Hold a fist (~2 sec)', col1, startY + rowH);
  text('〰  Flutter your fingers', col1, startY + rowH * 2);

  // Right column
  text('✌✌  Pinch twice', col2, startY);
  text('✌✌✌  Pinch three times', col2, startY + rowH);

  // Descriptions — smaller
  textSize(24);
  fill(30, 120, 30);

  text('Trigger and layer sounds', col1, startY + 42);
  text('Stop all sounds', col1, startY + rowH + 42);
  text('Add tremolo effect', col1, startY + rowH * 2 + 42);

  text('Volume down one step', col2, startY + 42);
  text('Volume up one step', col2, startY + rowH + 42);

  // Tip
  textAlign(CENTER, CENTER);
  textSize(26);
  fill(34, 139, 34, 180);
  text('You can use both hands at the same time', width / 2, height * 0.78);

  // Start prompt
  textSize(46);
  fill(34, 139, 34);
  // Gentle pulse to draw the eye
  let pulse = map(sin(frameCount * 0.05), -1, 1, 180, 255);
  fill(34, 139, 34, pulse);
  text('Press  SPACE  to begin', width / 2, height * 0.89);
}

function animateEllipses(handX, handY) {
  for (let i = 0; i < ellipses.length; i++) {
    let ellipseProps = ellipses[i];
    let distance = dist(handX, handY, ellipseProps.x, ellipseProps.y);

    if (distance < ellipseHoverRadius) {
      ellipseProps.isActive = true;
      ellipseProps.targetColor = soundColors[ballToSound[i]]; // Highlight active ball
    } else if (!isAnyHandNear(ellipseProps.x, ellipseProps.y)) {
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
      if (distance < ellipseHoverRadius) {
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