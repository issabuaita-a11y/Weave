let handPose;
let video;
let hands = [];
let sounds = [];
let activeSounds = new Set();
let ellipses = [];
let ballToSound = {};
let ellipseSpacing = 100;
let baseSize = 50;
let isPaused = true; // Track pause state
let frameSkip = 3; // Only update every 3 frames
let frameCount = 0;


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
  let fingertips = ['thumb_tip', 'index_finger_tip', 'middle_finger_tip', 'ring_finger_tip', 'pinky_tip'];

  for (let tip of fingertips) {
    let fingertip = hand.keypoints.find(k => k.name === tip);
    if (fingertip && wrist) {
      let distance = dist(fingertip.x, fingertip.y, wrist.x, wrist.y);
      if (distance > 50) { // Adjust threshold as needed
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
  let totalBalls = ellipses.length;
  let ballsPerSound = Math.floor(totalBalls / sounds.length); // Should be 4 per sound
  let extraBalls = totalBalls % sounds.length; // Handle any extra balls

  let soundIndex = 0;
  
  for (let i = 0; i < totalBalls; i++) {
    ballToSound[i] = soundIndex;
    
    if ((i + 1) % ballsPerSound === 0) {
      soundIndex = (soundIndex + 1) % sounds.length; // Cycle through sounds
    }
  }
}


function drawEllipses() {
  noStroke();
  for (let ellipseProps of ellipses) {
    // Smoothly transition to target colors and sizes
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
  let maxDistance = 100; // Adjusted for smaller coverage

  for (let i = 0; i < ellipses.length; i++) {
    let ellipseProps = ellipses[i];
    let distance = dist(handX, handY, ellipseProps.x, ellipseProps.y);

    if (distance < maxDistance) {
      ellipseProps.isActive = true;
      ellipseProps.targetColor = soundColors[ballToSound[i]]; // Highlight active ball
    } else if (!isAnyHandNear(ellipseProps.x, ellipseProps.y)) {
      ellipseProps.isActive = false;
      ellipseProps.targetColor = [255, 255, 255]; // Reset to white
    }
  }
}

function isAnyHandNear(x, y) {
  let maxDistance = 100; // Smaller hand coverage for accuracy

  for (let hand of hands) {
    let indexTip = hand.keypoints.find(k => k.name === 'index_finger_tip');
    if (indexTip) {
      let flippedX = width - indexTip.x;
      let distance = dist(flippedX, indexTip.y, x, y);
      if (distance < maxDistance) {
        return true;
      }
    }
  }
  return false;
}

function controlSoundForHand(x, y) {
  let soundIndex = floor(map(x, 0, width, 0, sounds.length));
  soundIndex = constrain(soundIndex, 0, sounds.length - 1);

  if (!activeSounds.has(soundIndex)) {
    activeSounds.add(soundIndex);
    if (!sounds[soundIndex].isPlaying()) {
      sounds[soundIndex].loop();
      sounds[soundIndex].setVolume(1); // Full volume
    }
  }
}

function stopInactiveSounds() {
  activeSounds.forEach((soundIndex) => {
    if (!hands.some((hand) => {
      let indexTip = hand.keypoints.find(k => k.name === 'index_finger_tip');
      if (indexTip) {
        let flippedX = width - indexTip.x;
        let assignedSound = floor(map(flippedX, 0, width, 0, sounds.length));
        return assignedSound === soundIndex;
      }
      return false;
    })) {
      sounds[soundIndex].setVolume(0, 0.5);
      setTimeout(() => {
        sounds[soundIndex].stop();
        activeSounds.delete(soundIndex);
      }, 500);
    }
  });
}

function stopAllSounds() {
  activeSounds.forEach((soundIndex) => {
    sounds[soundIndex].setVolume(0, 0.5);
    setTimeout(() => {
      sounds[soundIndex].stop();
      activeSounds.delete(soundIndex);
    }, 500);
  });
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