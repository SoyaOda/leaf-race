// Frame pipeline: opaque scene -> refraction copy -> water -> floating things -> bloom -> grade.
// Everything before the final pass is linear HDR in half-float targets; resolution is dynamic.
import * as THREE from 'three';
import { FullscreenPass } from './sim.js?v=a087d61d0b56';

export const LAYER_OPAQUE = 0;
export const LAYER_WATER = 1;
export const LAYER_FLOAT = 2;

const VS = 'in vec3 position; void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }';

const COPY = /* glsl */`
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  o = vec4(texture(uSrc, uv).rgb, 1.0);
}`;

const BRIGHT = /* glsl */`
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform vec2 uSrcTexel;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec3 c = vec3(0.0);
  c += texture(uSrc, uv + uSrcTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uSrc, uv + uSrcTexel * vec2( 1.0, -1.0)).rgb;
  c += texture(uSrc, uv + uSrcTexel * vec2(-1.0,  1.0)).rgb;
  c += texture(uSrc, uv + uSrcTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float k = max(l - 1.1, 0.0);
  k = k * k / (k + 1.6);
  o = vec4(min(c * k / max(l, 1e-4), vec3(30.0)), 1.0);
}`;

const BLUR = /* glsl */`
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform vec2 uDir;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec3 c = texture(uSrc, uv).rgb * 0.227;
  c += (texture(uSrc, uv + uDir * 1.385).rgb + texture(uSrc, uv - uDir * 1.385).rgb) * 0.316;
  c += (texture(uSrc, uv + uDir * 3.231).rgb + texture(uSrc, uv - uDir * 3.231).rgb) * 0.070;
  o = vec4(c, 1.0);
}`;

const FINAL = /* glsl */`
precision highp float;
uniform sampler2D uScene; uniform sampler2D uBloom; uniform sampler2D uBloom2;
uniform vec2 uTexel; uniform float uExposure; uniform float uBloomStr; uniform float uTime;
uniform float uFade; uniform float uDesat;
out vec4 o;
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec3 col = texture(uScene, uv).rgb;
  col += (texture(uBloom, uv).rgb * 0.6 + texture(uBloom2, uv).rgb * 0.4) * uBloomStr;
  col *= uExposure;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // dusk grade: violet in the shadows, apricot in the highlights
  col = mix(col, col * vec3(1.07, 0.98, 0.88), smoothstep(0.25, 1.6, l));
  col += vec3(0.010, 0.006, 0.020) * (1.0 - smoothstep(0.0, 0.35, l));
  col = aces(col);
  col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), uDesat);
  vec2 q = uv - 0.5;
  float vig = smoothstep(0.95, 0.25, length(q * vec2(0.92, 1.0)));
  col *= mix(0.72, 1.0, vig);
  col = toSRGB(col);
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * (2.2 / 255.0);
  o = vec4(col * uFade, 1.0);
}`;

function hdrTarget(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: false, depthBuffer: false, ...opts,
  });
}

function pass(frag, uniforms) {
  return new FullscreenPass(new THREE.RawShaderMaterial({
    vertexShader: VS, fragmentShader: frag, uniforms, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  }));
}

export class Pipeline {
  constructor(renderer, tier) {
    this.renderer = renderer;
    this.tier = tier;
    this.bloomOn = tier.bloom;
    this.scene = hdrTarget(4, 4, { depthBuffer: true, samples: tier.msaa });
    this.refr = hdrTarget(2, 2);
    this.b1 = hdrTarget(2, 2); this.b1b = hdrTarget(2, 2);
    this.b2 = hdrTarget(2, 2); this.b2b = hdrTarget(2, 2);
    this.copy = pass(COPY, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.bright = pass(BRIGHT, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uSrcTexel: { value: new THREE.Vector2() } });
    this.blur = pass(BLUR, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2() } });
    this.final = pass(FINAL, {
      uScene: { value: this.scene.texture }, uBloom: { value: this.b1.texture }, uBloom2: { value: this.b2.texture },
      uTexel: { value: new THREE.Vector2() }, uExposure: { value: 1.12 }, uBloomStr: { value: tier.bloom ? 0.55 : 0 },
      uTime: { value: 0 }, uFade: { value: 1 }, uDesat: { value: 0 },
    });
    this.width = 0; this.height = 0;
  }

  setSize(w, h) {
    w = Math.max(64, Math.round(w)); h = Math.max(64, Math.round(h));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.scene.setSize(w, h);
    this.refr.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    this.b1.setSize(Math.ceil(w / 4), Math.ceil(h / 4)); this.b1b.setSize(Math.ceil(w / 4), Math.ceil(h / 4));
    this.b2.setSize(Math.ceil(w / 8), Math.ceil(h / 8)); this.b2b.setSize(Math.ceil(w / 8), Math.ceil(h / 8));
  }

  renderFrame(scene, camera, water, outW, outH, time) {
    const r = this.renderer;
    const bg = scene.background;
    // 1. opaque world
    r.shadowMap.needsUpdate = true;
    camera.layers.set(LAYER_OPAQUE);
    r.setRenderTarget(this.scene);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, camera);
    // 2. refraction source (half resolution, resolves MSAA)
    this.copy.material.uniforms.uSrc.value = this.scene.texture;
    this.copy.material.uniforms.uTexel.value.set(1 / this.refr.width, 1 / this.refr.height);
    this.copy.render(r, this.refr);
    // 3. water, then things floating on it
    scene.background = null;
    water.uniforms.uRefr.value = this.refr.texture;
    water.uniforms.uResolution.value.set(this.width, this.height);
    r.setRenderTarget(this.scene);
    camera.layers.set(LAYER_WATER);
    r.render(scene, camera);
    camera.layers.set(LAYER_FLOAT);
    r.render(scene, camera);
    scene.background = bg;
    camera.layers.enable(LAYER_OPAQUE);
    // 4. bloom
    if (this.bloomOn) {
      const bu = this.bright.material.uniforms;
      bu.uSrc.value = this.scene.texture;
      bu.uTexel.value.set(1 / this.b1.width, 1 / this.b1.height);
      bu.uSrcTexel.value.set(1 / this.width, 1 / this.height);
      this.bright.render(r, this.b1);
      this.blurPass(this.b1, this.b1b);
      this.copy.material.uniforms.uSrc.value = this.b1.texture;
      this.copy.material.uniforms.uTexel.value.set(1 / this.b2.width, 1 / this.b2.height);
      this.copy.render(r, this.b2);
      this.blurPass(this.b2, this.b2b);
    }
    // 5. grade to screen
    const fu = this.final.material.uniforms;
    fu.uTexel.value.set(1 / outW, 1 / outH);
    fu.uTime.value = time;
    r.setRenderTarget(null);
    r.setViewport(0, 0, outW, outH);
    this.final.render(r, null);
  }

  blurPass(a, tmp) {
    const u = this.blur.material.uniforms;
    u.uTexel.value.set(1 / a.width, 1 / a.height);
    u.uSrc.value = a.texture; u.uDir.value.set(1 / a.width, 0);
    this.blur.render(this.renderer, tmp);
    u.uSrc.value = tmp.texture; u.uDir.value.set(0, 1 / a.height);
    this.blur.render(this.renderer, a);
  }
}
