import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BLOOM, CHOIR, GHOST, GLOW, HIGHLIGHT, INTERFERENCE, KIND_LOOK, PALETTE, SKY, TRAIL } from './config';
import { NO_POSITION, directionFromAltAz, type SkyFrame } from './sky-frame';
import type { FramePair } from './sky-stream';
import { pickNearest } from './picking';

/** The sky's own colour: the clear colour, and what the haze fades objects into. */
const SKY_COLOR = PALETTE.sky;

/**
 * Draw order of the transparent layers, back to front. Objects, their rings and the
 * trail sit under the haze, so they emerge together as they climb. The graticule and
 * compass labels sit above it, so the structure of the dome stays legible right down
 * to the horizon - move `graticule` below `haze` to let the haze swallow it too.
 */
const RENDER_ORDER = {
  /** The airglow and its grain, under everything - it is what the frame is made of. */
  backdrop: -3,
  /**
   * **Under the objects**, since 2026-09-18. A track drawn over its own satellite puts
   * a line across the mark it belongs to, and the mark is the thing being looked at;
   * the orbit is where it has been. They shared an order before and the tie was broken
   * by whichever material three sorted first, which is not a decision anyone made.
   */
  trail: -2,
  points: -1,
  rings: 0,
  haze: 1,
  graticule: 2,
} as const;

/** Horizontal coordinates to scene space, scaled. The mapping itself lives in sky-frame.ts. */
const scratch = [0, 0, 0];
export function altAzToVec3(azimuth: number, elevation: number, radius: number, out = new THREE.Vector3()) {
  directionFromAltAz(azimuth, elevation, scratch);
  return out.set(scratch[0]! * radius, scratch[1]! * radius, scratch[2]! * radius);
}

/**
 * Every object is drawn from TWO propagation ticks at once and blended on the GPU,
 * every frame, by one uniform. Ticks arrive a few times a second; the CPU work per
 * rendered frame is setting `uT`.
 *
 * Blending unit direction vectors and renormalising, rather than azimuth and
 * elevation, sidesteps the 359° -> 1° wrap entirely: there is no seam in a vector.
 *
 * This chunk is shared by the points and by the highlight rings, which draw the same
 * buffers through an index - so a ring can never drift from the object it encloses.
 *
 * position / aDir1  : unit direction from the observer at tick slot 0 / slot 1
 * aState0 / aState1 : x = shadow fraction, y = range km (negative = no position)
 */
const BLEND_GLSL = /* glsl */ `
  attribute vec3 aDir1;
  attribute vec2 aState0;
  attribute vec2 aState1;

  uniform float uT;
  uniform float uSinLowest;

  bool blendTicks(out vec3 dir, out float shadow, out float range) {
    dir = vec3(0.0);
    shadow = 0.0;
    range = 0.0;
    if (aState0.y < 0.0 || aState1.y < 0.0) return false;
    vec3 blended = mix(position, aDir1, uT);
    if (dot(blended, blended) < 1e-12) return false;
    dir = normalize(blended);
    if (dir.y < uSinLowest) return false;
    shadow = mix(aState0.x, aState1.x, uT);
    range = mix(aState0.y, aState1.y, uT);
    return true;
  }
`;

/**
 * Wreckage tearing the picture, in a small disc around each kept shard.
 *
 * A **post-effect over a small copied patch of the finished frame**, not a displacement
 * of the objects, and not a fullscreen pass.
 * Moving the marks themselves reads as physics - as if the fragment were shoving
 * satellites about - and the thing being said is that the *image* is corrupted. So the
 * scene is drawn to a target and this pass tears it: rows of pixels slide sideways, and
 * within a torn row the brightest sample wins, which drags bright things out into
 * streaks. That last part is pixel sorting done cheaply, and it is what stops the
 * effect reading as a mere offset.
 *
 * Its reach is a **radius in screen pixels**, unlike the sound's, which is an angle.
 * That disagreement is on purpose: the sound is about the sky and this is about the
 * display. What they share is the cause.
 *
 * **It reads back a square of the canvas rather than rendering the scene to a target.**
 * That is three's own `FramebufferTexture` pattern, and taking it saved two separate
 * problems and most of the cost:
 *
 * - The canvas already holds display-ready sRGB bytes, so the patch is sampled and
 *   written back untouched. A render target instead receives **linear** values - three
 *   chooses the output encoding from `renderer.outputColorSpace` only when drawing to
 *   the canvas - which has to be encoded by hand on the way out, and, worse, cannot be
 *   stored in 8 bits at all for a sky this dark: #05070a is about 0.0015-0.003 linear,
 *   which quantises to 0 or 1 out of 255. The measured symptom was empty sky coming
 *   back as (0, 13, 13) against its true (5, 7, 10). A half-float target fixed it, and
 *   then none of it was needed.
 * - A fullscreen pass shades every pixel on screen; this shades a square around each
 *   shard. On a software rasteriser the fullscreen version cost **165 ms a frame
 *   against 24**, and while that number would be far smaller on a real GPU, the shape
 *   of the work was simply wrong.
 *
 * The tear pattern is quantised on `floor(uTime * uSteps)`, so a band holds its offset
 * for a whole step. Continuous motion would read as a wobble; breaking up is discrete.
 */
const GLITCH_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // A fullscreen quad: the position is already clip space, so no matrices.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const GLITCH_FRAG = /* glsl */ `
  uniform sampler2D uPatch;
  /** The patch's size, and where the shard sits inside it, both in CSS pixels. */
  uniform vec2 uPatchPx;
  uniform vec2 uCentrePx;
  uniform float uRadiusPx;
  uniform float uBandPx;
  /** 0 tears in rows, 1 in columns. Per fragment, so several do not agree. */
  uniform float uAxis;
  uniform float uShiftPx;
  uniform float uSmearPx;
  uniform float uTearChance;
  uniform float uSteps;
  uniform float uTime;

  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  void main() {
    vec4 base = texture2D(uPatch, vUv);
    vec2 px = vUv * uPatchPx;

    float mask = 1.0 - smoothstep(uRadiusPx * 0.45, uRadiusPx, distance(px, uCentrePx));
    if (mask <= 0.002) { gl_FragColor = base; return; }

    // Bands run across one axis and slide along the other. Which axis is the
    // fragment's own, so several active at once do not comb the frame one way.
    bool vertical = uAxis > 0.5;
    float across = vertical ? px.x : px.y;
    // One texel step along the sliding axis, in UV.
    vec2 along = vertical ? vec2(0.0, 1.0 / uPatchPx.y) : vec2(1.0 / uPatchPx.x, 0.0);

    // Most bands are untouched on any given step. Sparse is what makes it a tear
    // rather than a texture.
    float tick = floor(uTime * uSteps);
    float band = floor(across / uBandPx);
    if (hash(vec2(band, tick)) < 1.0 - uTearChance) { gl_FragColor = base; return; }

    float shift = (hash(vec2(band, tick + 31.0)) - 0.5) * 2.0 * uShiftPx * mask;
    vec2 uv = vUv + along * shift;
    vec4 torn = texture2D(uPatch, uv);

    // Pixel sorting, cheaply: the brightest sample along this band wins, so whatever
    // is bright smears out into a streak instead of the band simply sliding.
    float smear = uSmearPx * mask * hash(vec2(band, tick + 7.0));
    float bestL = luma(torn.rgb);
    for (int i = 1; i <= 8; i++) {
      vec4 c = texture2D(uPatch, uv - along * (float(i) / 8.0 * smear));
      float l = luma(c.rgb);
      if (l > bestL) { bestL = l; torn = c; }
    }
    gl_FragColor = mix(base, torn, mask);
  }
`;

/**
 * Deterministic 0..1 from an index and a salt - the same `sin`-and-fract trick the
 * point shader uses for the debris tumble, so a fragment's look is the same every time.
 */
function hash01(index: number, salt: number): number {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** A track's last few degrees above the horizon, dissolving to nothing at it. */
function fade(y: number, top: number): number {
  const t = Math.min(Math.max(y / top, 0), 1);
  return t * t * (3 - 2 * t);
}

/** Outside clip space with zero size: the vertex draws nothing. */
const HIDE_GLSL = /* glsl */ `gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0;`;

/**
 * Appearance - what a thing is, what state it is in, size by range - is decided from
 * the blended values, so an object changes colour exactly where it crosses the
 * horizon on screen, not at the next tick.
 *
 * Hue is category and value is state; see PALETTE. A geostationary object is blue
 * whether it is lit, eclipsed or below the horizon, because belonging to the belt is
 * a permanent fact about it. Wreckage differs in texture rather than hue: smaller,
 * and without the glow that makes a payload read as something lit.
 */
const POINT_VERT = /* glsl */ `
  ${BLEND_GLSL}

  attribute float aChoir;
  attribute float aKind;
  attribute float aIndex;

  uniform float uRadius;
  uniform float uPixelRatio;
  uniform vec3 uColorLit;
  uniform vec3 uColorEclipsed;
  uniform vec3 uColorBelow;
  uniform vec3 uColorChoir;
  uniform vec2 uRocketLook;
  uniform vec3 uDebrisLook;
  uniform float uTime;
  /** 1 on the object itself; less on each ghost behind it. See GHOST. */
  uniform float uGhostLevel;
  uniform float uGhostSize;
  /**
   * How far back along the blend this ghost's streak reaches, and the viewport in
   * device pixels so the answer can be turned into a length on screen. Zero on the
   * object itself, which is then a plain round sprite as before.
   */
  uniform float uGhostStreak;
  uniform vec2 uViewport;
  /** GLOW: x how far the halo reaches as a multiple of the dot, y how bright it is. */
  uniform vec2 uHalo;

  varying float vAlpha;
  varying vec3 vColor;
  varying float vGlow;
  /** 0 = a light, 1 = a shard. */
  varying float vShard;
  /** cos/sin of this fragment's own tumble, so no two agree. */
  varying vec2 vSpin;
  /** The sprite's size in device pixels. gl_PointSize is vertex-only - a fragment
      shader that reads it fails to compile, and the whole points draw disappears. */
  varying float vSizePx;
  /** The streak's direction in sprite coordinates, and its length in device pixels. */
  varying vec2 vStreak;
  varying float vStreakPx;
  /** The DOT's own width in device pixels - the sprite is this plus its halo and its
      streak, and every shape below is measured against the dot rather than the sprite. */
  varying float vDotPx;

  /** Where a blended direction lands on screen, in device pixels. */
  vec2 toScreen(vec3 dir) {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(dir * uRadius, 1.0);
    return (clip.xy / max(clip.w, 1e-6)) * 0.5 * uViewport;
  }

  void main() {
    vec3 dir;
    float shadow;
    float range;
    if (!blendTicks(dir, shadow, range)) {
      ${HIDE_GLSL}
      vAlpha = 0.0;
      vColor = vec3(0.0);
      vGlow = 0.0;
      vShard = 0.0;
      vSpin = vec2(1.0, 0.0);
      vSizePx = 0.0;
      vStreak = vec2(1.0, 0.0);
      vStreakPx = 0.0;
      vDotPx = 0.0;
      return;
    }

    bool above = dir.y >= 0.0;
    bool lit = shadow < 0.5;
    bool choir = aChoir > 0.5;

    // The belt casts no ghost. Those objects do not move, so every copy would land on
    // the original and, under additive blending, simply make it brighter - the belt
    // would flare as the clock sped up. Instead the still things stay still while
    // everything else smears, which is the contrast the piece already trades on.
    if (uGhostLevel < 1.0 && choir) {
      ${HIDE_GLSL}
      vAlpha = 0.0;
      vColor = vec3(0.0);
      vGlow = 0.0;
      vShard = 0.0;
      vSpin = vec2(1.0, 0.0);
      vSizePx = 0.0;
      vStreak = vec2(1.0, 0.0);
      vStreakPx = 0.0;
      vDotPx = 0.0;
      return;
    }

    vColor = choir ? uColorChoir : (above ? (lit ? uColorLit : uColorEclipsed) : uColorBelow);
    vAlpha = above ? (choir ? 1.0 : (lit ? 1.0 : 0.6)) : 0.3;
    vColor *= uGhostLevel;

    // KIND: 0 payload, 1 rocket body, 2 debris. Debris is a shard, not a light: a
    // turning triangle drawn in the fragment shader, so it costs no geometry.
    vShard = aKind > 1.5 ? 1.0 : 0.0;
    float size = aKind > 1.5 ? uDebrisLook.x : (aKind > 0.5 ? uRocketLook.x : 1.0);
    vGlow = aKind > 1.5 ? uDebrisLook.y : (aKind > 0.5 ? uRocketLook.y : 1.0);

    // A hash off the object's own index: every fragment tumbles at its own rate, from
    // its own starting angle, and the field never falls into step with itself.
    float h = fract(sin(aIndex * 12.9898) * 43758.5453);
    float angle = uTime * uDebrisLook.z * mix(0.55, 1.7, h) + h * 6.2831853;
    vSpin = vec2(cos(angle), sin(angle));

    // Nearer objects read as larger. Purely a depth cue - the dome has no scale.
    float nearness = clamp(1.0 - (range - 400.0) / 4000.0, 0.25, 1.0);
    float dot16 = (above ? 16.0 : 8.0) * nearness * size * uPixelRatio * uGhostSize;

    // A ghost is a streak, not a dot: it covers the gap back to the ghost behind it,
    // so the trail joins up instead of reading as a row of beads. The span is worked
    // out on screen rather than in the sky, because that is where the gap is - project
    // both ends of this ghost's share of the chord and subtract.
    vStreak = vec2(1.0, 0.0);
    vStreakPx = 0.0;
    vec2 here = toScreen(dir);
    if (uGhostStreak != 0.0) {
      vec3 back = mix(position, aDir1, uT + uGhostStreak);
      if (dot(back, back) > 1e-12) {
        vec2 delta = toScreen(normalize(back)) - here;
        float len = length(delta);
        if (len > 0.5) {
          // gl_PointCoord runs downwards, clip space upwards.
          vStreak = vec2(delta.x, -delta.y) / len;
          vStreakPx = min(len, 96.0 * uPixelRatio);
        }
      }
    }

    // The sprite has to contain the capsule: a rectangle of L by w fits inside a
    // square of side L + w at any rotation, so this is enough and no more - plus the
    // halo, which only a light has. A shard is not a light and does not glow.
    vDotPx = dot16;
    vSizePx = dot16 * (vShard > 0.5 ? 1.0 : uHalo.x) + vStreakPx;
    gl_PointSize = vSizePx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(dir * uRadius, 1.0);
  }
`;

const POINT_FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  varying float vGlow;
  varying float vShard;
  varying vec2 vSpin;
  varying float vSizePx;
  varying vec2 vStreak;
  varying float vStreakPx;
  varying float vDotPx;

  uniform vec2 uHalo;

  /**
   * Sweep a sprite along its streak: collapse the point onto the segment first and
   * every shape below becomes its own capsule, drawn with the same code. A dot turns
   * into a rounded stroke, a shard into a swept shard.
   */
  vec2 sweep(vec2 p) {
    if (vStreakPx <= 0.0) return p;
    float halfLen = 0.5 * vStreakPx / max(vSizePx, 1.0);
    vec2 n = vec2(-vStreak.y, vStreak.x);
    vec2 q = vec2(dot(p, vStreak), dot(p, n));
    q.x = sign(q.x) * max(abs(q.x) - halfLen, 0.0);
    return q.x * vStreak + q.y * n;
  }

  /** iq's equilateral triangle, signed: negative inside. */
  float sdTriangle(vec2 p, float r) {
    const float k = 1.7320508;
    p.x = abs(p.x) - r;
    p.y = p.y + r / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
    p.x -= clamp(p.x, -2.0 * r, 0.0);
    return -length(p) * sign(p.y);
  }

  void main() {
    // Blending is additive, which multiplies rgb by alpha and adds: intensity
    // therefore belongs in rgb, and the alpha channel stays at 1.
    vec2 d = sweep(gl_PointCoord - vec2(0.5));

    if (vShard > 0.5) {
      // Debris: a flat shard, turning. No core, no halo - it is not a light.
      vec2 p = mat2(vSpin.x, -vSpin.y, vSpin.y, vSpin.x) * d * (vSizePx / max(vDotPx, 1.0));
      float t = sdTriangle(p, 0.40);
      // One-pixel edge, in sprite units, so it stays crisp at any size.
      float aa = 1.5 / max(vSizePx, 1.0);
      float fill = 1.0 - smoothstep(-aa, aa, t);
      if (fill <= 0.0) discard;
      gl_FragColor = vec4(vColor * vGlow * fill * vAlpha, 1.0);
      return;
    }

    // Soft round sprite with a hot core, so dense clusters still read as many. The
    // radius is the DOT's width, not the sprite's - a streaked or haloed sprite is
    // larger, and measuring against it would fatten the stroke as the trail grew.
    // So r = 1 is the dot's own edge whatever else the sprite is carrying.
    float r = length(d) * 2.0 * vSizePx / max(vDotPx, 1.0);
    if (r > uHalo.x) discard;
    float core = smoothstep(1.0, 0.0, r);
    float glow = pow(core, 2.5);
    /*
     * The halo: broad, soft, and reaching well past the dot - what fills the black
     * between objects without a post pass touching the frame.
     *
     * It is worth knowing what this does beyond looking better. Blending is additive,
     * so haloes **sum**: a crowded patch of sky comes out brighter than a sparse one
     * by more than the count of its marks. Density becomes a quantity the eye reads
     * off the image directly, which is the thing this piece is about.
     */
    float halo = pow(max(1.0 - r / uHalo.x, 0.0), 2.0);
    gl_FragColor = vec4(vColor * (0.22 * core + 1.9 * glow * vGlow + uHalo.y * halo * vGlow) * vAlpha, 1.0);
  }
`;

/**
 * Three kinds of ring share one draw, because they are all the same ring: the plain
 * white one the readout puts on whatever is highest, the amber one the pointer puts
 * on what it is touching, and the amber one a click leaves behind.
 *
 * Hover is a uniform compared against a static per-object index, so sweeping the
 * pointer across the sky uploads nothing at all. Marks are a per-object attribute,
 * re-uploaded on a click - rare enough that the whole column can go at once.
 *
 * A marked ring's brightness comes from the blended elevation, in the shader, so it
 * fades as the object descends in exact step with what is drawn, and in step with the
 * readout's ordering. Its row in the panel dims by the same curve.
 */
const RING_VERT = /* glsl */ `
  ${BLEND_GLSL}

  attribute float aIndex;
  attribute float aMark;
  attribute float aChoir;
  attribute float aKind;

  uniform float uRadius;
  uniform float uPixelRatio;
  uniform float uRingPx;
  uniform float uChoirPx;
  uniform float uHovered;
  uniform float uHoverScale;
  uniform vec3 uRingColor;
  uniform vec3 uMarkColor;
  uniform vec3 uDebrisColor;
  uniform vec3 uChoirColor;
  uniform float uDimAtHorizon;
  uniform float uFullBright;

  uniform float uStrokePx;
  uniform float uChoirStrokePx;

  varying float vSizePx;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vStrokePx;

  void main() {
    vec3 dir;
    float shadow;
    float range;
    if (!blendTicks(dir, shadow, range)) {
      ${HIDE_GLSL}
      vSizePx = 0.0;
      vColor = vec3(0.0);
      vAlpha = 0.0;
      vStrokePx = 0.0;
      return;
    }

    bool hovered = abs(aIndex - uHovered) < 0.5;
    bool marked = aMark > 0.5;
    bool choir = aChoir > 0.5;

    float elevation = asin(clamp(dir.y, -1.0, 1.0));
    float bright = mix(uDimAtHorizon, 1.0, clamp(elevation / uFullBright, 0.0, 1.0));

    // A choir object is never in the readout, so a ring on one is always the
    // pointer's. Blue, smaller, and at a steady brightness: it does not climb or
    // descend, so dimming it by elevation would say something that is not true.
    //
    // Everything else takes an attention colour when touched or kept, and **which**
    // attention colour says what kind of thing it is: amber for a satellite, pink for
    // wreckage. Merely being listed stays white for both, so the readout's own ring
    // keeps meaning "this one has a row" rather than doubling as a category.
    vec3 attention = aKind > 1.5 ? uDebrisColor : uMarkColor;
    vColor = choir ? uChoirColor : ((hovered || marked) ? attention : uRingColor);
    vAlpha = choir ? 1.0 : (hovered ? 1.0 : (marked ? bright : 1.0));

    vStrokePx = choir ? uChoirStrokePx : uStrokePx;
    vSizePx = (choir ? uChoirPx : uRingPx) * (hovered ? uHoverScale : 1.0) * uPixelRatio;
    gl_PointSize = vSizePx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(dir * uRadius, 1.0);
  }
`;

const RING_FRAG = /* glsl */ `
  uniform float uPixelRatio;

  varying float vSizePx;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vStrokePx;

  void main() {
    // Work in device pixels so the stroke is the same width at any size, with a
    // one-pixel antialiased edge and a pixel of margin inside the sprite.
    float dist = length(gl_PointCoord - vec2(0.5)) * vSizePx;
    float stroke = vStrokePx * uPixelRatio;
    float ringRadius = 0.5 * vSizePx - 0.5 * stroke - 1.0;
    float alpha = 1.0 - smoothstep(-0.5, 0.5, abs(dist - ringRadius) - 0.5 * stroke);
    alpha *= vAlpha;
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

/**
 * The haze is a band of sphere from the horizon to `topDeg`, sky-coloured, with its
 * opacity computed per pixel from the true elevation - so the gradient is smooth
 * however coarse the geometry.
 */
/**
 * The backdrop: the sky's own colour lifted toward the horizon, with a pixel of grain
 * over it. Drawn before everything, so it is the surface the whole image sits on.
 *
 * See SKY.backdrop for why the lift is cool rather than warm, and why the grain is
 * worth its two lines.
 */
/**
 * The sky's own colour at a given **sine** of elevation: PALETTE.sky lifted toward
 * SKY.backdrop.color as it nears the horizon.
 *
 * Shared by the backdrop and the haze, and it has to be shared. The haze paints sky
 * colour over objects as they sink - so a haze that painted the *flat* sky would erase
 * the airglow in exactly the band where the airglow is strongest, and leave a seam
 * along the horizon with a dark sky above it and a lit ground below it. That is what
 * the first version did, and it read as the floor leaking. A hazed object has to fade
 * into the sky that is actually there.
 *
 * On the sine rather than the angle: monotonic either way, indistinguishable in a
 * gradient this soft, and it saves an asin on every pixel of the screen - see the cost
 * note in buildBackdrop.
 */
const SKY_RAMP_GLSL = /* glsl */ `
  uniform vec3 uSky;
  uniform vec3 uGlow;
  uniform float uStrength;
  uniform float uSinTop;
  uniform float uFalloff;

  vec3 skyAt(float sinElevation) {
    float t = clamp(sinElevation / uSinTop, 0.0, 1.0);
    float lift = pow(1.0 - t, uFalloff) * uStrength;
    // Cut at the horizon. Airglow is something the sky does and there is no sky down
    // there; the ground disc is only 0.72 opaque, so a lift that ran on underneath it
    // would show through and the ground would glow.
    lift *= smoothstep(-0.03, 0.0, sinElevation);
    return mix(uSky, uGlow, lift);
  }
`;

const BACKDROP_VERT = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    // Normalised here rather than in the fragment shader: this is a sphere, so the
    // interpolated vector is barely under unit length across a face and the gradient
    // cannot tell the difference - and it saves a square root on every pixel of the
    // screen. See the cost note in buildBackdrop.
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BACKDROP_FRAG = /* glsl */ `
  ${SKY_RAMP_GLSL}

  uniform float uGrain;
  uniform vec3 uGround;
  uniform vec3 uSheen;
  uniform vec2 uStretch;
  uniform float uAmount;
  uniform float uSpeed;
  uniform float uTime;

  varying vec3 vDirection;

  /**
   * Below the horizon: a dark field with slow sheens drifting across it.
   *
   * **There is nothing identifiable down here on purpose.** What was here before was a
   * mirror of the objects, and it read as a duplicate of the data rather than as a
   * surface - a sixteen-pixel disc does not stop being a disc when you flip it. No
   * points, no edges, nothing with a period a viewer can count.
   *
   * The coordinate is the ray projected onto a plane one unit below the eye, so the
   * sheens compress toward the horizon the way anything lying flat does. The distance
   * is clamped, because that projection runs to infinity at the horizon and an
   * unclamped one aliases into a shimmering comb exactly where the eye is looking.
   */
  vec2 groundPlane(vec3 dir) {
    return vec2(dir.x, dir.z) / max(-dir.y, 0.02);
  }

  /**
   * A field that **evolves in place rather than sliding past**, which is the whole of
   * what makes this read as incidental light instead of as something being moved about.
   *
   * Three waves whose directions and rates are all incommensurate: no two of them agree
   * on a velocity, so their sum has none. It boils. One translating layer - which is
   * what was here before - gives the pattern a direction, and anything with a direction
   * reads as an object with somewhere to be.
   */
  float swell(vec2 p, float t) {
    return (sin(p.x + p.y * 0.35 + t)
      + sin(p.x * -0.55 + p.y * 0.80 - t * 0.73)
      + sin(p.x * 0.30 - p.y * 1.20 + t * 1.31)) / 3.0;
  }

  vec3 groundAt(vec3 dir) {
    vec2 q = groundPlane(dir) * uStretch;
    float t = uTime * uSpeed;
    // The warp runs on its own slower clock, so the shapes deform as well as drift -
    // a rigid pattern under a moving warp still reads as a rigid pattern.
    // Two plain sines are enough here: the warp only has to break up regularity, and
    // the field it distorts is already boiling. Warping with two more swells looked
    // no different and cost twelve sines a pixel against six - see the note on cost in
    // buildBackdrop, because this is the fullscreen pass and it pays for everything.
    q += 0.7 * vec2(sin(q.y * 0.45 + t * 0.55), cos(q.x * 0.38 - t * 0.61));
    // One extra scale, because a field of same-sized anythings reads as a set of
    // objects. A single higher-frequency term is enough to break that up.
    float v = swell(q, t) + 0.22 * sin(q.x * 2.6 - q.y * 1.9 + t * 1.17);
    // Soft-edged and mostly dark: squared rather than thresholded, so nothing in it
    // ever acquires a boundary.
    v = smoothstep(-0.15, 0.85, v);
    v *= v;
    // Held off the horizon itself, where the projection is densest and would alias,
    // and faded again as the surface turns to face the eye further down.
    float band = smoothstep(0.015, 0.11, -dir.y) * (1.0 - smoothstep(0.42, 1.0, -dir.y));
    return mix(uGround, uSheen, v * band * uAmount);
  }

  void main() {
    gl_FragColor = vec4(vDirection.y >= 0.0 ? skyAt(vDirection.y) : groundAt(vDirection), 1.0);

    // Colour-managed like the clear colour and the haze, so an unlifted patch is
    // exactly empty sky.
    #include <colorspace_fragment>

    /*
     * Grain, added **after** that conversion, and this is the whole of the trick.
     *
     * sRGB's toe is steep - near black it multiplies by 12.92 - so a 0.012 of noise
     * mixed in before the conversion arrives at around 39/255 on screen, which is
     * static, not grain. Added here it is 0.012 of the output, about 3/255, which is
     * what dissolves the banding this gradient would otherwise show in 8 bits.
     *
     * Hashed on gl_FragCoord, so it holds still in the frame while the sky turns
     * behind it: it is the image's noise floor, not something painted on the dome.
     *
     * Jimenez's interleaved-gradient dither rather than the usual
     * fract(sin(dot(...)) * 43758.5): two fracts and a dot against a transcendental,
     * on every pixel of the screen. This shader is the only fullscreen pass in the
     * app and it pays for everything twice.
     */
    float n = fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)));
    gl_FragColor.rgb += (fract(52.9829189 * n) - 0.5) * uGrain;
  }
`;

/**
 * The glow pass. Four fullscreen quads, all of them working in display space - see
 * BLOOM in config.ts for why that is the safe choice here and not a shortcut.
 *
 * The vertex shader writes clip coordinates straight out, so no camera matters.
 */
const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Take what is bright enough to bleed, and shrink it on the way. */
const BLOOM_CUT_FRAG = /* glsl */ `
  uniform sampler2D uSource;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;

  void main() {
    // Four taps rather than one: at a fraction of the resolution a single-pixel
    // highlight lands between samples more often than not, and a mark would flicker
    // into and out of its own glow as it crossed the sky.
    vec3 c = texture2D(uSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    c += texture2D(uSource, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    c += texture2D(uSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    c += texture2D(uSource, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    c *= 0.25;
    // Against the brightest channel, so a saturated blue mark bleeds like a white one
    // of the same intensity rather than a third as much.
    float level = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + uKnee, level), 1.0);
  }
`;

/**
 * One axis of a separable Gaussian: nine taps expressed as five, by landing each pair
 * between two texels and letting the bilinear filter weight them.
 *
 * **The offsets are not scalable**, and that was a real bug worth keeping. Stretching
 * them to widen the glow pulls the five taps apart into separate lobes, and what the
 * screen shows is a **box** around every bright mark rather than a halo - a Gaussian
 * sampled at four-texel gaps is not a Gaussian. Reach comes from running the pair more
 * than once (`BLOOM.passes`) and from the downscale, never from moving these.
 */
const BLOOM_BLUR_FRAG = /* glsl */ `
  uniform sampler2D uSource;
  uniform vec2 uStep;
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D(uSource, vUv).rgb * 0.2270270270;
    c += texture2D(uSource, vUv + uStep * 1.3846153846).rgb * 0.3162162162;
    c += texture2D(uSource, vUv - uStep * 1.3846153846).rgb * 0.3162162162;
    c += texture2D(uSource, vUv + uStep * 3.2307692308).rgb * 0.0702702703;
    c += texture2D(uSource, vUv - uStep * 3.2307692308).rgb * 0.0702702703;
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** Add it back over the frame. Additive, so the glow only ever lightens. */
const BLOOM_ADD_FRAG = /* glsl */ `
  uniform sampler2D uSource;
  uniform float uStrength;
  varying vec2 vUv;

  void main() {
    gl_FragColor = vec4(texture2D(uSource, vUv).rgb * uStrength, 1.0);
  }
`;

const HAZE_VERT = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HAZE_FRAG = /* glsl */ `
  ${SKY_RAMP_GLSL}

  uniform float uOpacity;
  uniform float uTop;

  varying vec3 vDirection;

  void main() {
    vec3 dir = normalize(vDirection);
    float elevation = asin(clamp(dir.y, -1.0, 1.0));
    float t = clamp(elevation / uTop, 0.0, 1.0);
    // The colour it fades objects into is the sky that is actually at that elevation,
    // airglow included - not the flat clear colour. See SKY_RAMP_GLSL.
    gl_FragColor = vec4(skyAt(dir.y), uOpacity * (1.0 - smoothstep(0.0, 1.0, t)));
    // Colour-managed like the clear colour, so a fully hazed patch is exactly the
    // sky rather than a slightly darker band.
    #include <colorspace_fragment>
  }
`;

/** Sunlit, above horizon: what you could actually see with the naked eye. */
const COLOR_LIT = new THREE.Color(PALETTE.lit);
/** In Earth's shadow: present, tracked, invisible to the eye. */
const COLOR_ECLIPSED = new THREE.Color(PALETTE.eclipsed);
/** Below the horizon: on the other side of the world. */
const COLOR_BELOW = new THREE.Color(PALETTE.below);
/** The geosynchronous belt, in every state. */
const COLOR_CHOIR = new THREE.Color(PALETTE.geostationary);

/** How far a press may travel, in CSS pixels, and still count as a click. */
const DRAG_SLOP = 6;

/** How close to straight up or down the camera may look. See `render`. */
const ZENITH_LIMIT = {
  min: THREE.MathUtils.degToRad(-89),
  max: THREE.MathUtils.degToRad(89),
};

/** The pointer over the sky. Coordinates are viewport, as the events give them. */
export interface PointerHandlers {
  hover(clientX: number, clientY: number): void;
  leave(): void;
  click(clientX: number, clientY: number): void;
}

interface TickSlot {
  direction: THREE.BufferAttribute;
  state: THREE.BufferAttribute;
  frame: SkyFrame | null;
}

export class SkyScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private slots: [TickSlot, TickSlot];
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Where each object has just been: one draw each, furthest back first. */
  private ghosts: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  /**
   * Which way `uT` has to move to go backwards in time, and how far a whole ghost
   * span is. Zero while there is nothing to trail from - one tick on screen, or a
   * rate at which an object does not move far enough for a trail to mean anything.
   */
  private ghostStep = 0;
  readonly rings: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms = {
    uT: { value: 0 },
    uGhostLevel: { value: 1 },
    uGhostSize: { value: 1 },
    uGhostStreak: { value: 0 },
    /** The drawing buffer in device pixels, for the ghosts' screen-space streak. */
    uViewport: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: SKY.radius },
    uPixelRatio: { value: 1 },
    uSinLowest: { value: Math.sin(THREE.MathUtils.degToRad(SKY.lowestVisibleDeg)) },
    uColorLit: { value: COLOR_LIT },
    uColorEclipsed: { value: COLOR_ECLIPSED },
    uColorBelow: { value: COLOR_BELOW },
    uColorChoir: { value: COLOR_CHOIR },
    uRocketLook: { value: new THREE.Vector2(KIND_LOOK.rocketBody.size, KIND_LOOK.rocketBody.glow) },
    /** size, intensity, radians per second. */
    uDebrisLook: {
      value: new THREE.Vector3(
        KIND_LOOK.debris.size,
        KIND_LOOK.debris.intensity,
        (KIND_LOOK.debris.spinRpm * Math.PI * 2) / 60
      ),
    },
    /**
     * Seconds of WALL time, not scene time - the one quantity in the app that is
     * deliberately not read from the clock. The tumble is a property of the mark, not
     * of the orbit; at 100x a scene-time tumble would race, and there is no real
     * rotation rate in the elements to be faithful to anyway.
     */
    uTime: { value: 0 },
    uHalo: { value: new THREE.Vector2(GLOW.haloScale, GLOW.haloGain) },
  };

  /**
   * The sky's own colour ramp - PALETTE.sky lifted toward the airglow near the
   * horizon. Shared **by reference** between the backdrop and the haze, so the colour
   * an object fades into is exactly the colour behind it. See SKY_RAMP_GLSL.
   */
  private readonly skyRamp = {
    uSky: { value: new THREE.Color(SKY_COLOR) },
    uGlow: { value: new THREE.Color(SKY.backdrop.color) },
    uStrength: { value: SKY.backdrop.strength },
    uSinTop: { value: Math.sin(THREE.MathUtils.degToRad(SKY.backdrop.topDeg)) },
    uFalloff: { value: SKY.backdrop.falloff },
  };

  private highlightIndex: THREE.BufferAttribute;
  private highlightCount = 0;
  /** Per-object 0/1: is this one stuck to the pointer's last click. */
  private markAttribute: THREE.BufferAttribute;
  /** Per-object 0/1: is this one in the geosynchronous belt. Set once. */
  private choirAttribute: THREE.BufferAttribute;
  /** Per-object KIND: 0 payload, 1 rocket body, 2 debris. Set once. */
  private kindAttribute: THREE.BufferAttribute;
  private marked: number[] = [];
  private readonly ringUniforms;

  /**
   * The glow pass: a copy of the whole finished canvas, two low-resolution targets to
   * bounce the blur between, and one quad whose material is swapped per pass. Null
   * throughout when BLOOM.strength is 0, and then nothing below runs.
   */
  private bloomCopy: THREE.FramebufferTexture | null = null;
  private bloomA: THREE.WebGLRenderTarget | null = null;
  private bloomB: THREE.WebGLRenderTarget | null = null;
  private bloomPixelRatio = 0;
  private readonly bloomQuad: THREE.Mesh | null;
  private readonly bloomScene = new THREE.Scene();
  private readonly bloomCamera = new THREE.Camera();
  private readonly bloomCut;
  private readonly bloomBlur;
  private readonly bloomAdd;
  private readonly bloomOrigin = new THREE.Vector2(0, 0);

  /** A square of the finished canvas, copied back so the glitch pass can chew it. */
  private patch: THREE.FramebufferTexture | null = null;
  private patchPixelRatio = 0;
  private glitchScene: THREE.Scene;
  private glitchCamera = new THREE.Camera();
  readonly glitchUniforms;
  /** Kept shards, as unit directions. Projected to screen inside `render`. */
  private warpDirs = Array.from({ length: INTERFERENCE.maxSources }, () => new THREE.Vector3());
  /** Their catalogue indices, so each tears the same way every time it is kept. */
  private warpIds = new Int32Array(INTERFERENCE.maxSources);
  private warpCount = 0;
  private ndc = new THREE.Vector3();
  private copyAt = new THREE.Vector2();

  private tracks: LineSegments2;
  private trackMaterial: LineMaterial;
  private trackPositions: Float32Array;
  private trackColors: Float32Array;
  private trackBuffer: THREE.InterleavedBuffer;
  private trackColorBuffer: THREE.InterleavedBuffer;
  /** Segments, not samples: one track of N samples costs N-1 of these. */
  private trackCapacity: number;

  private yaw = 0;
  private pitch = THREE.MathUtils.degToRad(38);
  private pointer: PointerHandlers | null = null;
  private canvasRect: DOMRect;

  /**
   * `maxTracks` sizes the track buffers, counting only the segments actually drawn -
   * the parts above the horizon. A geostationary object's whole 70-minute track is
   * up, so that is the case this is sized for; a low pass contributes a tenth of it.
   */
  constructor(canvas: HTMLCanvasElement, count: number, maxTracks = 24) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(SKY_COLOR, 1);
    this.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();

    // Wide by default: the piece is about how much is up there, so seeing a large
    // slice of the dome at once matters more than an undistorted field of view.
    this.camera = new THREE.PerspectiveCamera(95, 1, 0.1, SKY.radius * 4);
    this.camera.position.set(0, 0, 0);

    const graticule = this.buildGraticule();
    graticule.renderOrder = RENDER_ORDER.graticule;
    this.scene.add(graticule);
    // Strength 0 removes the pass rather than drawing an invisible one: it is the app's
    // only fullscreen shading, so "off" has to mean the draw does not happen.
    if (SKY.backdrop.strength > 0) this.scene.add(this.buildBackdrop());
    this.scene.add(this.buildHaze());

    // --- satellites ---------------------------------------------------------
    const makeSlot = (): TickSlot => {
      const state = new Float32Array(count * 2);
      // Hidden until the first tick lands.
      for (let i = 0; i < count; i++) state[i * 2 + 1] = NO_POSITION;
      return {
        direction: new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage),
        state: new THREE.BufferAttribute(state, 2).setUsage(THREE.DynamicDrawUsage),
        frame: null,
      };
    };
    this.slots = [makeSlot(), makeSlot()];

    // What each object *is*, as opposed to where it is. Both fixed by the catalogue,
    // so they are uploaded once and never touched again - and shared by the points
    // and the rings, which must agree about which objects are the belt.
    this.choirAttribute = new THREE.BufferAttribute(new Float32Array(count), 1);
    this.kindAttribute = new THREE.BufferAttribute(new Float32Array(count), 1);
    // Its own vertex id. The rings compare it against the hover uniform; the points
    // hash it into a tumble phase, so every fragment of debris turns differently.
    const ids = new Float32Array(count);
    for (let i = 0; i < count; i++) ids[i] = i;
    const indexAttribute = new THREE.BufferAttribute(ids, 1);

    // Both geometries hold the SAME attribute objects, so three.js uploads each tick
    // once and the rings read exactly the buffers the points do.
    const withTicks = (geom: THREE.BufferGeometry) => {
      // three.js sizes a non-indexed draw from `position`, so slot 0's directions go there.
      geom.setAttribute('position', this.slots[0].direction);
      geom.setAttribute('aDir1', this.slots[1].direction);
      geom.setAttribute('aState0', this.slots[0].state);
      geom.setAttribute('aState1', this.slots[1].state);
      geom.setAttribute('aChoir', this.choirAttribute);
      geom.setAttribute('aKind', this.kindAttribute);
      geom.setAttribute('aIndex', indexAttribute);
      return geom;
    };

    const pointsGeom = withTicks(new THREE.BufferGeometry());
    pointsGeom.setDrawRange(0, count);
    this.points = new THREE.Points(
      pointsGeom,
      new THREE.ShaderMaterial({
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = RENDER_ORDER.points;
    this.scene.add(this.points);

    // --- ghosts -------------------------------------------------------------
    // The same geometry and the same shader, drawn again at a `uT` that has been run
    // backwards past the older tick. Spreading `this.uniforms` copies the references,
    // so every uniform but the three overridden here stays shared with the object
    // itself - a ghost can never disagree with what it follows about colour, size by
    // range, the horizon, or which fragment is a shard.
    for (let k = 0; k < GHOST.count; k++) {
      const ghost = new THREE.Points(
        pointsGeom,
        new THREE.ShaderMaterial({
          vertexShader: POINT_VERT,
          fragmentShader: POINT_FRAG,
          uniforms: {
            ...this.uniforms,
            uT: { value: 0 },
            uGhostLevel: { value: GHOST.level * Math.pow(GHOST.falloff, k) },
            uGhostSize: { value: GHOST.size },
            uGhostStreak: { value: 0 },
          },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      ghost.frustumCulled = false;
      ghost.renderOrder = RENDER_ORDER.points;
      ghost.visible = false;
      this.ghosts.push(ghost);
      this.scene.add(ghost);
    }

    // --- highlight rings ----------------------------------------------------
    const ringsGeom = withTicks(new THREE.BufferGeometry());
    this.markAttribute = new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    ringsGeom.setAttribute('aMark', this.markAttribute);
    // A ring per object is the ceiling: the readout's rows, every mark, and the hover.
    this.highlightIndex = new THREE.BufferAttribute(new Uint32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    ringsGeom.setIndex(this.highlightIndex);
    ringsGeom.setDrawRange(0, 0);
    this.ringUniforms = {
      uT: this.uniforms.uT,
      uSinLowest: this.uniforms.uSinLowest,
      uRadius: this.uniforms.uRadius,
      uPixelRatio: this.uniforms.uPixelRatio,
      uRingPx: { value: HIGHLIGHT.diameterPx },
      uStrokePx: { value: HIGHLIGHT.strokePx },
      uChoirPx: { value: CHOIR.diameterPx },
      uChoirStrokePx: { value: CHOIR.strokePx },
      uRingColor: { value: new THREE.Color(HIGHLIGHT.color) },
      uMarkColor: { value: new THREE.Color(HIGHLIGHT.markColor) },
      uDebrisColor: { value: new THREE.Color(HIGHLIGHT.debrisMarkColor) },
      uChoirColor: { value: new THREE.Color(CHOIR.color) },
      uHovered: { value: -1 },
      uHoverScale: { value: HIGHLIGHT.hoverScale },
      uDimAtHorizon: { value: HIGHLIGHT.dimAtHorizon },
      uFullBright: { value: THREE.MathUtils.degToRad(HIGHLIGHT.fullBrightDeg) },
    };
    this.rings = new THREE.Points(
      ringsGeom,
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: this.ringUniforms,
        transparent: true,
        depthWrite: false,
      })
    );
    this.rings.frustumCulled = false;
    this.rings.renderOrder = RENDER_ORDER.rings;
    this.scene.add(this.rings);

    // --- tracks ---------------------------------------------------------------
    // Real pixel-width lines. GL's own `linewidth` is one pixel whatever you ask for
    // on ANGLE, which is most of the desktop; these are instanced quads instead, so
    // the width in TRAIL means something. Every track shares one draw.
    const samples = Math.ceil(((TRAIL.pastMinutes + TRAIL.futureMinutes) * 60) / TRAIL.stepSeconds) + 1;
    this.trackCapacity = maxTracks * samples;
    this.trackPositions = new Float32Array(this.trackCapacity * 6);
    this.trackColors = new Float32Array(this.trackCapacity * 6);
    const trackGeom = new LineSegmentsGeometry();
    trackGeom.setPositions(this.trackPositions);
    trackGeom.setColors(this.trackColors);
    trackGeom.instanceCount = 0;
    this.trackBuffer = (trackGeom.attributes.instanceStart as THREE.InterleavedBufferAttribute).data;
    this.trackColorBuffer = (trackGeom.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data;
    this.trackMaterial = new LineMaterial({
      vertexColors: true,
      linewidth: TRAIL.widthPx,
      transparent: true,
      opacity: TRAIL.opacity,
      depthWrite: false,
    });
    this.tracks = new LineSegments2(trackGeom, this.trackMaterial);
    this.tracks.frustumCulled = false;
    this.tracks.renderOrder = RENDER_ORDER.trail;
    this.scene.add(this.tracks);

    // --- the glitch pass ------------------------------------------------------
    // The patch texture is made in `resize`, once the pixel ratio is known.
    this.glitchUniforms = {
      uPatch: { value: null as THREE.Texture | null },
      uPatchPx: { value: new THREE.Vector2(1, 1) },
      uCentrePx: { value: new THREE.Vector2() },
      uRadiusPx: { value: INTERFERENCE.sight.radiusPx },
      uBandPx: { value: INTERFERENCE.sight.bandPx[0] },
      uAxis: { value: 0 },
      uShiftPx: { value: INTERFERENCE.sight.shiftPx },
      uSmearPx: { value: INTERFERENCE.sight.smearPx },
      uTearChance: { value: INTERFERENCE.sight.tearChance },
      uSteps: { value: INTERFERENCE.sight.stepsPerSecond },
      // Wall seconds, shared with the debris tumble: this is a property of the mark
      // and of the screen, not of the orbit.
      uTime: this.uniforms.uTime,
    };
    this.glitchScene = new THREE.Scene();
    this.glitchScene.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.ShaderMaterial({
          vertexShader: GLITCH_VERT,
          fragmentShader: GLITCH_FRAG,
          uniforms: this.glitchUniforms,
          depthTest: false,
          depthWrite: false,
        })
      )
    );

    // --- the glow pass --------------------------------------------------------
    if (BLOOM.strength > 0) {
      this.bloomCut = new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: BLOOM_CUT_FRAG,
        uniforms: {
          uSource: { value: null },
          uTexel: { value: new THREE.Vector2() },
          uThreshold: { value: BLOOM.threshold },
          uKnee: { value: BLOOM.knee },
        },
        depthTest: false,
        depthWrite: false,
      });
      this.bloomBlur = new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: BLOOM_BLUR_FRAG,
        uniforms: { uSource: { value: null }, uStep: { value: new THREE.Vector2() } },
        depthTest: false,
        depthWrite: false,
      });
      this.bloomAdd = new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: BLOOM_ADD_FRAG,
        uniforms: { uSource: { value: null }, uStrength: { value: BLOOM.strength } },
        depthTest: false,
        depthWrite: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
      });
      this.bloomQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bloomCut);
      this.bloomQuad.frustumCulled = false;
      this.bloomScene.add(this.bloomQuad);
    } else {
      this.bloomQuad = null;
      this.bloomCut = null;
      this.bloomBlur = null;
      this.bloomAdd = null;
    }

    this.attachLook(canvas);
    this.canvasRect = canvas.getBoundingClientRect();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  /**
   * Show a pair of ticks blended by `t`. Uploads only a frame the GPU does not
   * already hold - normally one per tick, into whichever slot is now stale.
   */
  showFrames({ from, to, t }: FramePair) {
    const slotOf = (frame: SkyFrame) => (this.slots[0].frame === frame ? 0 : this.slots[1].frame === frame ? 1 : -1);
    let fromSlot = slotOf(from);
    let toSlot = slotOf(to);

    if (from === to) {
      if (fromSlot < 0) fromSlot = this.upload(0, from);
      this.uniforms.uT.value = fromSlot;
      // One tick on screen: there is no second position to run back towards.
      this.ghostStep = 0;
      this.placeGhosts();
      return;
    }

    if (fromSlot < 0 && toSlot < 0) {
      fromSlot = this.upload(0, from);
      toSlot = this.upload(1, to);
    } else if (fromSlot < 0) {
      fromSlot = this.upload(1 - toSlot, from);
    } else if (toSlot < 0) {
      toSlot = this.upload(1 - fromSlot, to);
    }

    // uT always runs slot 0 -> slot 1, whichever of them is older.
    this.uniforms.uT.value = fromSlot === 0 ? t : 1 - t;
    // Backwards is whichever way that is not. A ghost extrapolates past the older
    // tick, which `mix` does happily - the chord simply continues.
    this.ghostStep = (fromSlot === 0 ? -1 : 1) * (GHOST.spanTicks / GHOST.count);
    this.placeGhosts();
  }

  /**
   * Whether the trails are drawn at all, from the time rate.
   *
   * Called by the render loop, because the scene does not read the clock. They fade
   * in over the step above `fromRate` rather than appearing at full strength, so
   * changing rate does not flash the sky.
   */
  setTimeRate(rate: number) {
    const r = Math.abs(rate);
    const on = r > GHOST.fromRate;
    const fade = on ? Math.min(1, Math.log(r / GHOST.fromRate) / Math.log(10)) : 0;
    for (let k = 0; k < this.ghosts.length; k++) {
      const ghost = this.ghosts[k]!;
      ghost.visible = on && this.ghostStep !== 0;
      ghost.material.uniforms.uGhostLevel!.value = GHOST.level * Math.pow(GHOST.falloff, k) * fade;
    }
  }

  /** Each ghost one step further back along the chord the two ticks describe. */
  private placeGhosts() {
    const now = this.uniforms.uT.value;
    for (let k = 0; k < this.ghosts.length; k++) {
      const ghost = this.ghosts[k]!;
      ghost.material.uniforms.uT!.value = now + this.ghostStep * (k + 1);
      // Reach back one more step: this ghost's stroke ends where the next begins.
      ghost.material.uniforms.uGhostStreak!.value = this.ghostStep;
      if (this.ghostStep === 0) ghost.visible = false;
    }
  }

  /**
   * Ring these objects: what the readout lists, plus every mark, plus the hover.
   * Indices into the frame columns; only a change reaches the GPU, and a change is
   * a handful of integers.
   */
  setHighlights(indices: readonly number[]) {
    const index = this.highlightIndex.array as Uint32Array;
    const n = Math.min(indices.length, index.length);
    let changed = n !== this.highlightCount;
    for (let i = 0; i < n; i++) {
      if (index[i] !== indices[i]) {
        index[i] = indices[i]!;
        changed = true;
      }
    }
    if (!changed) return;
    this.highlightCount = n;
    this.highlightIndex.needsUpdate = true;
    this.rings.geometry.setDrawRange(0, n);
  }

  /**
   * Stick the amber ring to these objects and take it off the rest. Only a click
   * changes this, so re-uploading the whole column is cheaper than tracking ranges.
   */
  setMarks(marked: Iterable<number>): void {
    const mark = this.markAttribute.array as Float32Array;
    for (const i of this.marked) mark[i] = 0;
    this.marked = [...marked];
    for (const i of this.marked) if (i >= 0 && i < mark.length) mark[i] = 1;
    this.markAttribute.needsUpdate = true;
  }

  /**
   * What the objects are: which belong to the belt, and which are wreckage. Both are
   * fixed by the catalogue, so this is called once and the shader does the rest -
   * the CPU never touches appearance again.
   */
  setClasses(choir: Uint8Array, kind: Uint8Array): void {
    const choirFlags = this.choirAttribute.array as Float32Array;
    const kinds = this.kindAttribute.array as Float32Array;
    const n = Math.min(choir.length, choirFlags.length);
    for (let i = 0; i < n; i++) {
      choirFlags[i] = choir[i]!;
      kinds[i] = kind[i] ?? 0;
    }
    this.choirAttribute.needsUpdate = true;
    this.kindAttribute.needsUpdate = true;
  }

  /**
   * The kept shards. Their marks are untouched; what happens is that the *picture*
   * breaks up in a small disc around each of them - see `GLITCH_FRAG`.
   *
   * Directions are blended here exactly as the shader blends everything else, and
   * projected to screen inside `render`, after the camera has been pointed.
   */
  setWarpSources(pair: FramePair, indices: readonly number[]): void {
    const { from, to, t } = pair;
    let n = 0;
    for (const i of indices) {
      if (n >= this.warpDirs.length) break;
      if (from.range[i]! < 0 || to.range[i]! < 0) continue;
      const k = i * 3;
      const x = from.direction[k]! + (to.direction[k]! - from.direction[k]!) * t;
      const y = from.direction[k + 1]! + (to.direction[k + 1]! - from.direction[k + 1]!) * t;
      const z = from.direction[k + 2]! + (to.direction[k + 2]! - from.direction[k + 2]!) * t;
      const len = Math.hypot(x, y, z);
      if (len < 1e-6) continue;
      this.warpDirs[n]!.set(x / len, y / len, z / len);
      this.warpIds[n] = i;
      n++;
    }
    this.warpCount = n;
  }

  /** The object under the pointer, or -1. One uniform: a sweep uploads nothing. */
  setHovered(index: number): void {
    this.ringUniforms.uHovered.value = index;
  }

  /**
   * Which object is under these viewport coordinates, given what is on screen now.
   *
   * The canvas rectangle is the one taken at the last resize: reading it here would
   * flush layout inside the render loop, once per frame for as long as the pointer
   * is over the sky, and the canvas is fixed to the viewport anyway.
   */
  pickAt(pair: FramePair, clientX: number, clientY: number): number {
    return pickNearest({ camera: this.camera, rect: this.canvasRect }, pair, clientX, clientY, HIGHLIGHT.pickRadiusPx);
  }

  /** The pointer is over something takeable. */
  /**
   * Where the camera is looking, radians of yaw. The sound reads this: the stereo
   * axis is the camera's right vector, so turning to look sweeps the belt across the
   * field. Pitch does not enter into it - see the note in `Drone.update`.
   */
  get heading(): number {
    return this.yaw;
  }

  setPickCursor(over: boolean): void {
    this.renderer.domElement.classList.toggle('over', over);
  }

  private upload(index: number, frame: SkyFrame): number {
    const slot = this.slots[index]!;
    (slot.direction.array as Float32Array).set(frame.direction);
    const state = slot.state.array as Float32Array;
    for (let i = 0; i < frame.count; i++) {
      state[i * 2] = frame.shadow[i]!;
      state[i * 2 + 1] = frame.range[i]!;
    }
    slot.direction.needsUpdate = true;
    slot.state.needsUpdate = true;
    slot.frame = frame;
    return index;
  }

  /** Horizon ring, almucantars and meridians - the only structure in the scene. */
  private buildGraticule(): THREE.Group {
    const group = new THREE.Group();
    const R = SKY.radius;
    const ring = (elevationDeg: number, opacity: number) => {
      const el = THREE.MathUtils.degToRad(elevationDeg);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 256; i++) {
        pts.push(altAzToVec3((i / 256) * Math.PI * 2, el, R));
      }
      return new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x4a6f8a, transparent: true, opacity })
      );
    };

    group.add(ring(0, 0.85));
    for (const el of [15, 30, 45, 60, 75]) group.add(ring(el, 0.16));

    for (let i = 0; i < 16; i++) {
      const az = (i / 16) * Math.PI * 2;
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 48; j++) {
        pts.push(altAzToVec3(az, (j / 48) * (Math.PI / 2), R));
      }
      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({
            color: 0x4a6f8a,
            transparent: true,
            opacity: i % 4 === 0 ? 0.3 : 0.1,
          })
        )
      );
    }

    // Zenith: a small cross, so straight up is always locatable.
    const z = SKY.radius;
    const arm = SKY.radius * 0.035;
    group.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-arm, z, 0),
          new THREE.Vector3(arm, z, 0),
          new THREE.Vector3(0, z, -arm),
          new THREE.Vector3(0, z, arm),
        ]),
        new THREE.LineBasicMaterial({ color: 0x7fa6bf, transparent: true, opacity: 0.5 })
      )
    );

    for (const [label, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
      const sprite = this.makeLabel(label);
      altAzToVec3(THREE.MathUtils.degToRad(az), THREE.MathUtils.degToRad(3), R * 0.98, sprite.position);
      group.add(sprite);
    }

    return group;
  }

  private makeLabel(text: string): THREE.Sprite {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#8fb4cc';
    ctx.font = '600 46px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.65, depthWrite: false })
    );
    sprite.scale.setScalar(SKY.radius * 0.08);
    return sprite;
  }

  /**
   * The backdrop: airglow toward the horizon, and grain over the whole frame.
   *
   * A full sphere rather than a dome, because the camera looks down as well as up and
   * the ground disc is only 0.72 opaque. Drawn first and depth-tested against nothing
   * - every layer in this scene has `depthWrite: false`, so the depth buffer is never
   * written and `renderOrder` alone decides what covers what.
   *
   * **This is the app's only fullscreen pass, and it is the reason its shader is
   * written the way it is.** Every pixel of the screen runs it, every frame, so an
   * `asin` or a `sin` in there is a transcendental per pixel - which is why the ramp
   * runs on the sine of elevation, the direction is normalised in the vertex shader,
   * and the dither has no `sin` in it. Measured on a software rasteriser, where fill
   * cost is enormously exaggerated: +30.2 ms a frame before those three changes, +22.6
   * after, and **+29.5 once the ground moved in here** - the sheens are six sines on
   * whatever part of the screen is below the horizon, and twelve cost +35 while looking
   * no different.
   *
   * **Do not keep optimising the arithmetic; it is not where the cost is.** The same
   * sphere shaded with a constant colour - no varying, no ramp, no dither - still costs
   * +11.0 ms of that, so half the bill is a CPU rasteriser touching a million pixels
   * and would be nothing at all on a GPU. Replacing the `pow` with a cubic saved 0.6 ms,
   * which is noise, and cost a dial. `SKY.backdrop.strength` of 0 skips the mesh
   * entirely, which is the only change that removes the pass.
   */
  private buildBackdrop(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(SKY.radius * 1.5, 64, 48),
      new THREE.ShaderMaterial({
        vertexShader: BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        uniforms: {
          ...this.skyRamp,
          uGrain: { value: SKY.backdrop.grain },
          uGround: { value: new THREE.Color(SKY.ground.color) },
          uSheen: { value: new THREE.Color(SKY.ground.sheen) },
          uStretch: { value: new THREE.Vector2(SKY.ground.stretch[0], SKY.ground.stretch[1]) },
          uAmount: { value: SKY.ground.amount },
          uSpeed: { value: SKY.ground.speed },
          // Wall seconds, like the debris tumble: weather on a surface, not anything
          // the clock is doing.
          uTime: this.uniforms.uTime,
        },
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      })
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER.backdrop;
    return mesh;
  }

  /** Sky-coloured haze from the horizon up to SKY.haze.topDeg. */
  private buildHaze(): THREE.Mesh {
    const top = THREE.MathUtils.degToRad(SKY.haze.topDeg);
    // SphereGeometry measures theta down from +Y, so the band from elevation 0 to `top`
    // starts at theta = 90° - top and spans `top`.
    const geometry = new THREE.SphereGeometry(SKY.radius * 0.97, 128, 16, 0, Math.PI * 2, Math.PI / 2 - top, top);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: HAZE_VERT,
        fragmentShader: HAZE_FRAG,
        uniforms: {
          ...this.skyRamp,
          uOpacity: { value: SKY.haze.horizonOpacity },
          uTop: { value: top },
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.BackSide,
      })
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER.haze;
    return mesh;
  }

  /** Where the pointer is, and what it took. Picking itself happens in main. */
  setPointerHandlers(handlers: PointerHandlers): void {
    this.pointer = handlers;
  }

  /**
   * Drag to look around, and the same gesture carries hover and click.
   *
   * The two have to be told apart by hand: the canvas fills the window, so every
   * click to take an object begins as a potential drag. A press that travels less
   * than DRAG_SLOP is a click; anything further was someone turning to look, and
   * must not mark whatever happened to be under the release.
   */
  private attachLook(canvas: HTMLCanvasElement) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let travelled = 0;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      travelled = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
      if (travelled < DRAG_SLOP) this.pointer?.click(e.clientX, e.clientY);
      // The view may have turned under a still pointer: re-read what is beneath it.
      this.pointer?.hover(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) {
        this.pointer?.hover(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      travelled += Math.abs(dx) + Math.abs(dy);
      this.yaw -= dx * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, THREE.MathUtils.degToRad(-20), ZENITH_LIMIT.max);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    canvas.addEventListener('pointerleave', () => this.pointer?.leave());
    canvas.addEventListener('pointercancel', () => {
      dragging = false;
      this.pointer?.leave();
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + e.deltaY * 0.03, 25, 130);
        this.camera.updateProjectionMatrix();
        // The sky just moved under a still pointer; what it is on has changed.
        this.pointer?.hover(e.clientX, e.clientY);
      },
      { passive: false }
    );
  }

  /**
   * Draw these tracks across the dome, from unit directions.
   *
   * Each is **cut exactly at the horizon** and dissolved over the last few degrees
   * above it, so an orbit leaves the image where the object would leave the sky
   * instead of ploughing on through the ground. The crossing segment is clipped at
   * y = 0 rather than dropped, so the end of a track never depends on where the
   * 20-second samples happened to fall.
   *
   * The fade is baked into the vertex colours rather than into alpha: the sky and
   * the ground are both within a shade of black, so darkening and dissolving look
   * the same, and this way one material draws every track at once.
   */
  setTracks(tracks: readonly { directions: Float32Array; color: THREE.Color }[]): void {
    const R = SKY.radius * 0.995;
    const fadeTop = Math.sin(THREE.MathUtils.degToRad(TRAIL.fadeTopDeg));
    const pos = this.trackPositions;
    const col = this.trackColors;
    let n = 0;

    for (const { directions, color } of tracks) {
      const samples = Math.floor(directions.length / 3);
      for (let s = 0; s + 1 < samples; s++) {
        if (n >= this.trackCapacity) break;

        let ax = directions[s * 3]!;
        let ay = directions[s * 3 + 1]!;
        let az = directions[s * 3 + 2]!;
        let bx = directions[s * 3 + 3]!;
        let by = directions[s * 3 + 4]!;
        let bz = directions[s * 3 + 5]!;

        if (ay <= 0 && by <= 0) continue;

        if (ay < 0 || by < 0) {
          // Where the track crosses the horizon. Renormalised, so the cut lands on
          // the horizon circle rather than a little inside it.
          const t = ay / (ay - by);
          let cx = ax + (bx - ax) * t;
          let cz = az + (bz - az) * t;
          const len = Math.hypot(cx, cz) || 1;
          cx /= len;
          cz /= len;
          if (ay < 0) {
            ax = cx;
            ay = 0;
            az = cz;
          } else {
            bx = cx;
            by = 0;
            bz = cz;
          }
        }

        const k = n * 6;
        pos[k] = ax * R;
        pos[k + 1] = ay * R;
        pos[k + 2] = az * R;
        pos[k + 3] = bx * R;
        pos[k + 4] = by * R;
        pos[k + 5] = bz * R;

        const fa = fade(ay, fadeTop);
        const fb = fade(by, fadeTop);
        col[k] = color.r * fa;
        col[k + 1] = color.g * fa;
        col[k + 2] = color.b * fa;
        col[k + 3] = color.r * fb;
        col[k + 4] = color.g * fb;
        col[k + 5] = color.b * fb;
        n++;
      }
    }

    this.tracks.geometry.instanceCount = n;
    this.trackBuffer.needsUpdate = true;
    this.trackColorBuffer.needsUpdate = true;
  }

  render() {
    this.uniforms.uTime.value = performance.now() / 1000;
    // Clamped here, not only where the drag sets it. Looking exactly at the zenith
    // makes the view direction parallel to the camera's up vector, `lookAt` cannot
    // build a basis from it, and the entire scene disappears - which looks like a
    // rendering failure rather than a gimbal lock. Anything that sets pitch directly,
    // a debug snippet included, has to be safe.
    const pitch = THREE.MathUtils.clamp(this.pitch, ZENITH_LIMIT.min, ZENITH_LIMIT.max);
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(this.yaw) * Math.cos(pitch)
    );
    this.camera.lookAt(dir);

    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);

    // And then chew a square of it around each kept shard. Nothing kept, nothing to
    // do: this is the overwhelmingly common case and it costs one comparison.
    if (this.warpCount > 0 && this.patch) this.tearAtShards();

    // The glow goes last, so it reads the frame as it will actually be seen - torn
    // patches included. A shard that is breaking the picture up should bleed the
    // pieces, not the tidy version underneath them.
    this.bloom();
  }

  /**
   * Spread the bright parts of the finished canvas across everything.
   *
   * Four passes, all of them in display space - the copy is of the **canvas**, which
   * already holds sRGB bytes, and no shader here converts anything. That is what keeps
   * this clear of the trap that a render target receiving linear values cannot hold a
   * sky this dark in 8 bits. See BLOOM in config.ts.
   */
  private bloom(): void {
    const quad = this.bloomQuad;
    const a = this.bloomA;
    const b = this.bloomB;
    if (!quad || !a || !b || !this.bloomCopy) return;

    this.renderer.copyFramebufferToTexture(this.bloomCopy, this.bloomOrigin);

    // Cut what is bright enough to bleed, at a quarter size.
    this.bloomCut!.uniforms.uSource!.value = this.bloomCopy;
    quad.material = this.bloomCut!;
    this.renderer.setRenderTarget(a);
    this.renderer.render(this.bloomScene, this.bloomCamera);

    // Across, then down, as many times as it takes. Widening the kernel instead would
    // box every mark - see BLOOM_BLUR_FRAG. Each pair lands back in A, so the loop can
    // simply run again; the blurs compose, and n passes of sigma give sigma*sqrt(n).
    const step = this.bloomBlur!.uniforms.uStep!.value as THREE.Vector2;
    quad.material = this.bloomBlur!;
    for (let pass = 0; pass < BLOOM.passes; pass++) {
      this.bloomBlur!.uniforms.uSource!.value = a.texture;
      step.set(BLOOM.spread / a.width, 0);
      this.renderer.setRenderTarget(b);
      this.renderer.render(this.bloomScene, this.bloomCamera);

      this.bloomBlur!.uniforms.uSource!.value = b.texture;
      step.set(0, BLOOM.spread / a.height);
      this.renderer.setRenderTarget(a);
      this.renderer.render(this.bloomScene, this.bloomCamera);
    }

    // And back over the canvas, additively. autoClear off, or the frame this is meant
    // to be added to is wiped a moment before it gets there.
    this.renderer.setRenderTarget(null);
    this.bloomAdd!.uniforms.uSource!.value = a.texture;
    quad.material = this.bloomAdd!;
    this.renderer.autoClear = false;
    this.renderer.render(this.bloomScene, this.bloomCamera);
    this.renderer.autoClear = true;
  }

  /**
   * Copy a square of the finished canvas around each kept shard and redraw it torn.
   *
   * Projection happens here rather than where the sources were set, because the camera
   * has only just been pointed. Everything below is in CSS pixels with the origin at
   * the bottom left, which is what both `setViewport` and the shader work in; the copy
   * itself wants device pixels, which is the one conversion.
   */
  private tearAtShards(): void {
    const w = innerWidth;
    const h = innerHeight;
    const side = 2 * INTERFERENCE.sight.radiusPx;
    if (side > w || side > h) return;

    const ratio = this.patchPixelRatio;
    this.camera.updateMatrixWorld();
    this.renderer.autoClear = false;

    for (let k = 0; k < this.warpCount; k++) {
      const d = this.warpDirs[k]!;
      this.ndc.set(d.x, d.y, d.z).multiplyScalar(SKY.radius).project(this.camera);
      // Behind the camera, or past the far plane: nothing to tear.
      if (this.ndc.z > 1) continue;
      const sx = (this.ndc.x * 0.5 + 0.5) * w;
      const sy = (this.ndc.y * 0.5 + 0.5) * h;
      if (sx < -side || sx > w + side || sy < -side || sy > h + side) continue;

      // The square is clamped to the canvas, so near an edge the shard sits off-centre
      // inside it rather than the patch hanging over the side.
      const x0 = Math.min(Math.max(Math.round(sx - side / 2), 0), w - side);
      const y0 = Math.min(Math.max(Math.round(sy - side / 2), 0), h - side);
      this.glitchUniforms.uCentrePx.value.set(sx - x0, sy - y0);

      // The band thickness and the axis are this fragment's own, from a hash of its
      // catalogue index - the same trick the debris tumble uses. A given piece of
      // wreckage therefore always tears the same way, and two kept at once will not
      // comb the frame at one pitch in one direction.
      const id = this.warpIds[k]!;
      const band = INTERFERENCE.sight.bandPx;
      this.glitchUniforms.uBandPx.value = band[0]! + (band[1]! - band[0]!) * hash01(id, 3);
      this.glitchUniforms.uAxis.value = hash01(id, 5) < INTERFERENCE.sight.verticalChance ? 1 : 0;

      this.copyAt.set(Math.round(x0 * ratio), Math.round(y0 * ratio));
      this.renderer.copyFramebufferToTexture(this.patch!, this.copyAt);
      this.renderer.setViewport(x0, y0, side, side);
      this.renderer.setScissor(x0, y0, side, side);
      this.renderer.setScissorTest(true);
      this.renderer.render(this.glitchScene, this.glitchCamera);
    }

    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.autoClear = true;
  }

  private resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    const ratio = this.renderer.getPixelRatio();
    this.uniforms.uViewport.value.set(w * ratio, h * ratio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.canvasRect = this.renderer.domElement.getBoundingClientRect();
    // Pixel-width lines need to know how large a pixel is, and so does the glitch.
    this.trackMaterial.resolution.set(w, h);
    // The patch is a fixed square in CSS pixels; only a change of device pixel ratio
    // can resize it, so it is built once and kept.
    // The glow's buffers follow the canvas, so they are rebuilt whenever it changes.
    if (this.bloomQuad && (ratio !== this.bloomPixelRatio || this.bloomA?.width !== Math.max(1, Math.floor((w * ratio) / BLOOM.downscale)))) {
      this.bloomPixelRatio = ratio;
      const dw = Math.max(1, Math.round(w * ratio));
      const dh = Math.max(1, Math.round(h * ratio));
      const lw = Math.max(1, Math.floor(dw / BLOOM.downscale));
      const lh = Math.max(1, Math.floor(dh / BLOOM.downscale));

      this.bloomCopy?.dispose();
      this.bloomCopy = new THREE.FramebufferTexture(dw, dh);
      // Raw bytes, decoded by nobody: the canvas is already display-encoded and every
      // shader in the chain treats these values as data rather than as colour.
      this.bloomCopy.colorSpace = THREE.NoColorSpace;
      this.bloomCopy.minFilter = THREE.LinearFilter;
      this.bloomCopy.magFilter = THREE.LinearFilter;
      this.bloomCut!.uniforms.uTexel!.value.set(1 / dw, 1 / dh);

      this.bloomA?.dispose();
      this.bloomB?.dispose();
      const opts = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        colorSpace: THREE.NoColorSpace,
      } as const;
      this.bloomA = new THREE.WebGLRenderTarget(lw, lh, opts);
      this.bloomB = new THREE.WebGLRenderTarget(lw, lh, opts);
    }

    if (ratio !== this.patchPixelRatio) {
      this.patchPixelRatio = ratio;
      this.patch?.dispose();
      const side = Math.max(2, Math.round(2 * INTERFERENCE.sight.radiusPx * ratio));
      this.patch = new THREE.FramebufferTexture(side, side);
      this.glitchUniforms.uPatch.value = this.patch;
      this.glitchUniforms.uPatchPx.value.setScalar(side / ratio);
    }
  }
}
