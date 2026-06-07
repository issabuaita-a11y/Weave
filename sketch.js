let handPose;
let video;
let hands = [];
let sounds = [];
let activeSounds = new Set();
let soundStopTimers = [];
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
  handPose = ml5.handPose();

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
    return;
  }

  hands.forEach((hand) => {
    let indexTip = hand.keypoints.find(k => k.name === 'index_finger_tip');
    if (indexTip) {
      let flippedX = width - indexTip.x; // Flip the x-axis for natural interaction
      animateEllipses(flippedX, indexTip.y);
      controlSoundForHand(flippedX, indexTip.y);
    }

    // Detect fist gesture
    if (detectFist(hand)) {
      stopAllSounds(); // Stop all sounds
      resetEllipses(); // Reset ellipses to default state
    }
  });

  stopInactiveSounds();
}

function detectFist(hand) {
  let wrist = hand.keypoints.find(k => k.name === 'wrist');
  let middleKnuckle = hand.keypoints.find(k => k.name === 'middle_finger_mcp');
  if (!wrist || !middleKnuckle) return false;

  // Use the wrist-to-knuckle distance as a "hand scale" reference so the
  // fist threshold adapts to hand size — which varies with camera
  // resolution, lens, and how far the user stands from the camera.
  let handScale = dist(wrist.x, wrist.y, middleKnuckle.x, middleKnuckle.y);
  if (handScale === 0) return false;

  let closedThreshold = handScale * 1.3;
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

function controlSoundForHand(x, y) {
  let soundIndex = soundIndexForPosition(x, y);

  cancelStopTimer(soundIndex); // hand is back on this sound — don't let a queued stop kill it

  if (!activeSounds.has(soundIndex)) {
    activeSounds.add(soundIndex);
    sounds[soundIndex].setVolume(1);
    if (!sounds[soundIndex].isPlaying()) {
      sounds[soundIndex].loop();
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

function stopInactiveSounds() {
  let activeZones = new Set();
  for (let hand of hands) {
    let indexTip = hand.keypoints.find(k => k.name === 'index_finger_tip');
    if (indexTip) {
      activeZones.add(soundIndexForPosition(width - indexTip.x, indexTip.y));
    }
  }

  // Copy to an array first — scheduleStop mutates activeSounds asynchronously,
  // and mutating a Set while iterating it is asking for trouble.
  for (let soundIndex of [...activeSounds]) {
    if (!activeZones.has(soundIndex) && !soundStopTimers[soundIndex]) {
      scheduleStop(soundIndex);
    }
  }
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