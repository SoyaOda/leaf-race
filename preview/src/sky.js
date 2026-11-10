// Late-afternoon sky: the Poly Haven HDRI regraded (clear blue zenith, apricot horizon,
// a glow around the sun). Shared by the sky dome and the water reflections so they always match.
import * as THREE from 'three';
import { SUN } from './config.js?v=f337fed88ee5';

export const SKY_GLSL = /* glsl */`
uniform sampler2D uSky;
uniform float uSkyRot;
uniform vec3 uSunDirW;
vec3 skyColor(vec3 d) {
  float c = cos(-uSkyRot), s = sin(-uSkyRot);
  vec3 r = vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
  vec2 uv = vec2(atan(r.z, r.x) * 0.15915494 + 0.5, asin(clamp(r.y, -1.0, 1.0)) * 0.31830988 + 0.5);
  vec3 hdr = texture(uSky, uv).rgb;
  float up = clamp(d.y, 0.0, 1.0);
  float toSun = max(dot(normalize(d), uSunDirW), 0.0);
  vec3 tint = mix(vec3(1.35, 0.95, 0.66), vec3(0.62, 0.74, 1.05), smoothstep(0.02, 0.45, up));
  tint = mix(tint, vec3(1.45, 0.92, 0.6), pow(toSun, 3.0) * 0.7);
  vec3 col = hdr * tint * 0.46;
  col += vec3(1.0, 0.62, 0.32) * (pow(toSun, 12.0) * 1.6 + pow(toSun, 900.0) * 30.0);
  col += vec3(0.5, 0.26, 0.14) * pow(1.0 - up, 6.0) * 0.35;
  return col;
}
`;

export function makeSkyDome(skyTex) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSky: { value: skyTex },
      uSkyRot: { value: SUN.envRotationY },
      uSunDirW: { value: new THREE.Vector3(...SUN.dir) },
    },
    vertexShader: /* glsl */`
      out vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      ${SKY_GLSL}
      in vec3 vDir;
      out vec4 fragColor;
      void main() { fragColor = vec4(skyColor(normalize(vDir)), 1.0); }`,
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat);
  m.frustumCulled = false;
  m.renderOrder = 10;       // after the ground: only the pixels still open get the sky shader
  return m;
}
