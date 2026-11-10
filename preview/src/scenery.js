// Everything around the stream: sky and sun, the plank bridge, the finish string, the stone culvert,
// bank vegetation, a bamboo stand and autumn trees on the hill, a little jizo by the lane, fields beyond.
import * as THREE from 'three';
import { WORLD, SUN, RIVALS } from './config.js?v=f337fed88ee5';
import { groundHeight, halfWidth, centerOffset, fbm, toWorld, heading, restEta, nearest, laneHeight, LANE } from './course.js?v=f337fed88ee5';
import { makePlumeTexture, makeFlagTexture } from './textures.js?v=f337fed88ee5';
import { makeSkyDome } from './sky.js?v=f337fed88ee5';

const sunDir = new THREE.Vector3(...SUN.dir);
const sunRad = new THREE.Vector3(...SUN.color).multiplyScalar(SUN.intensity);
const windTime = { value: 0 };
// What the child is watching. Grass on the line between the eyes and this point bends out of the way.
const sightPoint = { value: new THREE.Vector3(0, -100, 0) };
const w2 = [0, 0];

function rng(seed) { let s = seed >>> 0; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296); }

// backlit translucency and wind for thin vegetation
function translucent(mat, amount, key, nearFade = false) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirW = { value: sunDir };
    shader.uniforms.uSunRad = { value: sunRad };
    shader.uniforms.uTime = windTime;
    shader.uniforms.uSight = sightPoint;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uSight;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float ph = uTime * 1.7 + ip.x * 2.1 + ip.y * 1.3;
          float gust = 0.55 + 0.45 * sin(uTime * 0.31 + ip.y * 0.3);
          float b = (sin(ph) * 0.6 + sin(ph * 2.7 + 1.3) * 0.25) * gust;
          float hh = max(position.y, 0.0);
          transformed.x += b * hh * hh * ${(0.12 * amount).toFixed(3)};
          transformed.z += b * hh * hh * ${(0.06 * amount).toFixed(3)};
          ${nearFade ? `{
            vec3 ic = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
            vec3 toSight = uSight - cameraPosition;
            float along = clamp(dot(ic - cameraPosition, toSight) / dot(toSight, toSight), 0.0, 1.0);
            float offLine = distance(ic, cameraPosition + toSight * along);
            transformed *= smoothstep(0.8, 1.6, distance(ic, cameraPosition)) * mix(0.2, 1.0, smoothstep(0.1, 0.34, offLine));
          }` : ''}
        }
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDirW;\nuniform vec3 uSunRad;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          vec3 sunV = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
          float back = pow(max(dot(-normalize(vViewPosition), sunV), 0.0), 4.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * uSunRad * back * ${(0.9 * amount).toFixed(2)};
        }`);
  };
  mat.customProgramCacheKey = () => `veg-${key}`;
  return mat;
}

// A horizontal frame at s: origin on the centreline, T along, N across.
function frameAt(s) {
  const th = heading(s);
  toWorld(s, 0, w2);
  return { o: new THREE.Vector3(w2[0], 0, w2[1]), T: new THREE.Vector3(Math.sin(th), 0, Math.cos(th)), N: new THREE.Vector3(Math.cos(th), 0, -Math.sin(th)), th };
}

export class Scenery {
  constructor(scene, tex, tier, renderer) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.setupSky(scene, tex, renderer);
    this.setupSun(scene, tier);
    this.buildPlankBridge();
    this.buildGoal();
    this.buildCulvert(tex);
    this.buildGrass(tier.grass);
    this.buildSusuki();
    this.buildHiganbana();
    this.buildFallenLeaves(tier);
    this.buildBamboo();
    this.buildTrees();
    this.buildJizo();
    this.buildFence();
    this.buildFarland();
    this.buildDragonflies();
  }

  // Sky light for every material. Lives only on the GPU, so it is baked again after a lost context.
  bakeEnvironment(tex, renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromEquirectangular(tex.sky).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;
  }

  setupSky(scene, tex, renderer) {
    this.bakeEnvironment(tex, renderer);
    scene.environmentIntensity = 0.85;
    scene.environmentRotation = new THREE.Euler(0, SUN.envRotationY, 0);
    this.skyDome = makeSkyDome(tex.sky);
    scene.add(this.skyDome);
    this.fogColor = new THREE.Color(0.66, 0.5, 0.4);
    scene.fog = new THREE.FogExp2(this.fogColor, 0.012);
  }

  setupSun(scene, tier) {
    const light = new THREE.DirectionalLight(new THREE.Color(...SUN.color), SUN.intensity);
    light.castShadow = true;
    light.shadow.mapSize.set(tier.shadow, tier.shadow);
    const c = light.shadow.camera;
    c.left = -2.6; c.right = 2.6; c.top = 2.6; c.bottom = -2.6; c.near = 0.5; c.far = 40;
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.008;
    scene.add(light, light.target);
    this.sun = light;
  }

  // follow the camera focus so the shadow map texels stay where they matter
  update(time, camera, focus, sight) {
    windTime.value = time;
    if (sight) sightPoint.value.copy(sight); else sightPoint.value.set(0, -100, 0);
    this.sun.position.copy(focus).addScaledVector(sunDir, 15);
    this.sun.target.position.copy(focus);
    if (this.flag) {
      this.flag.rotation.x = 0.12 * Math.sin(time * 2.1) + 0.05 * Math.sin(time * 5.3);
      this.flag.rotation.y = this.flagYaw + 0.15 * Math.sin(time * 1.3);
    }
    this.updateDragonflies(time, focus);
  }

  // Two weathered boards over the water at the start, on two stakes.
  buildPlankBridge() {
    const s = 0.95;
    const f = frameAt(s);
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 256;
    const g = cv.getContext('2d');
    const r = rng(31);
    g.fillStyle = '#6d5a43'; g.fillRect(0, 0, 64, 256);
    for (let i = 0; i < 90; i++) {
      g.strokeStyle = `rgba(${40 + r() * 60},${30 + r() * 40},${20 + r() * 30},${0.15 + r() * 0.3})`;
      g.lineWidth = 0.5 + r() * 1.4;
      const x = r() * 64;
      g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + r() * 6 - 3, 90, x + r() * 6 - 3, 170, x + r() * 4 - 2, 256); g.stroke();
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const wood = new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 });
    const y = laneHeight(s) + 0.03;
    for (const [off, w] of [[-0.09, 0.13], [0.07, 0.15]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.028, w), wood);
      b.position.copy(f.o).addScaledVector(f.T, off); b.position.y = y + off * 0.03;
      b.rotation.y = f.th - Math.PI / 2 + Math.PI / 2 + Math.PI / 2 * 0 + (off * 0.1);
      b.rotateY(0);
      b.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.th + off * 0.15);
      b.castShadow = b.receiveShadow = true;
      this.group.add(b);
    }
    const stake = new THREE.MeshStandardMaterial({ color: 0x4b3d2d, roughness: 0.95 });
    for (const n of [-0.42, 0.42]) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.42, 7), stake);
      m.position.copy(f.o).addScaledVector(f.N, n).addScaledVector(f.T, 0.02); m.position.y = y - 0.22;
      m.castShadow = true;
      this.group.add(m);
    }
  }

  buildGoal() {
    const s = WORLD.FINISH_S;
    const f = frameAt(s);
    const nc = centerOffset(s), hw = halfWidth(s);
    const bamboo = new THREE.MeshStandardMaterial({ color: 0xa9b35a, roughness: 0.45 });
    const node = new THREE.MeshStandardMaterial({ color: 0x8a8f40, roughness: 0.5 });
    const tops = [];
    for (const side of [-1, 1]) {
      const n = nc + side * (hw + 0.13);
      const g = groundHeight(s, n);
      const h = 1.14;
      const lean = side * 0.035;
      const base = f.o.clone().addScaledVector(f.N, n);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.0115, h, 9), bamboo);
      pole.position.copy(base); pole.position.y = g + h / 2 - 0.03;
      pole.rotation.set(0, f.th, -lean);
      pole.castShadow = true;
      this.group.add(pole);
      for (let k = 1; k < 4; k++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0108, 0.0022, 6, 12), node);
        ring.rotation.x = Math.PI / 2;
        ring.position.copy(base).addScaledVector(f.N, -lean * (k * 0.28 - 0.57)); ring.position.y = g - 0.03 + k * 0.28;
        this.group.add(ring);
      }
      const top = base.clone().addScaledVector(f.N, -lean * 0.5); top.y = g + h - 0.07;
      tops.push(top);
    }
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const p = tops[0].clone().lerp(tops[1], t);
      p.y -= 0.08 * 4 * t * (1 - t);
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 4;
    const g = cv.getContext('2d');
    g.fillStyle = '#f4efe6'; g.fillRect(0, 0, 64, 4); g.fillStyle = '#d0322a'; g.fillRect(0, 0, 32, 4);
    const st = new THREE.CanvasTexture(cv); st.colorSpace = THREE.SRGBColorSpace; st.wrapS = THREE.RepeatWrapping; st.repeat.set(8, 1);
    const string = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.0028, 5), new THREE.MeshStandardMaterial({ map: st, roughness: 0.8 }));
    string.castShadow = true;
    this.group.add(string);
    const flagMat = new THREE.MeshStandardMaterial({ map: makeFlagTexture(), side: THREE.DoubleSide, roughness: 0.85 });
    const flagGeo = new THREE.PlaneGeometry(0.2, 0.125);
    flagGeo.translate(0, -0.063, 0);
    flagGeo.rotateY(Math.PI);     // faces upstream
    this.flag = new THREE.Mesh(flagGeo, flagMat);
    this.flag.position.copy(curve.getPoint(0.5));
    this.flagYaw = f.th;
    this.flag.rotation.order = 'YXZ';
    this.flag.castShadow = true;
    this.group.add(this.flag);
  }

  // The stream disappears into an old stone headwall under the lane.
  buildCulvert(tex) {
    const s = WORLD.CULVERT_S;
    const f = frameAt(s);
    const eta = restEta(s);
    const hw = halfWidth(s) + 0.05;
    const mat = new THREE.MeshStandardMaterial({ map: tex.wall.albedo.clone(), roughness: 0.95, color: 0xc9c2b2 });
    mat.map.needsUpdate = true;
    const box = (n0, n1, y0, y1, depth, along = 0.2) => {
      const g = new THREE.BoxGeometry(n1 - n0, y1 - y0, depth);
      const uv = g.attributes.uv, p = g.attributes.position;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) + (n0 + n1) / 2) / 0.7, (p.getY(i) + (y0 + y1) / 2) / 0.7);
      const m = new THREE.Mesh(g, mat);
      m.position.copy(f.o).addScaledVector(f.N, (n0 + n1) / 2).addScaledVector(f.T, along);
      m.position.y = (y0 + y1) / 2;
      m.rotation.y = f.th;
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
    };
    const top = eta + 0.42, bot = eta - 0.3, mouth = eta + 0.2;
    box(-2.6, -hw, bot, top, 0.4);
    box(hw, 2.6, bot, top, 0.4);
    box(-hw, hw, mouth, top, 0.4);
    const tunnel = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, mouth - bot, 2.0), new THREE.MeshStandardMaterial({ color: 0x090a0b, roughness: 1, side: THREE.BackSide }));
    tunnel.position.copy(f.o).addScaledVector(f.T, 1.2); tunnel.position.y = (mouth + bot) / 2;
    tunnel.rotation.y = f.th;
    this.group.add(tunnel);
    // the lane it carries
    const lane = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.2), new THREE.MeshStandardMaterial({ color: 0x8a7860, roughness: 0.96 }));
    lane.rotation.x = -Math.PI / 2; lane.rotation.z = f.th;
    lane.position.copy(f.o).addScaledVector(f.T, 1.1); lane.position.y = top + 0.006;
    lane.receiveShadow = true;
    this.group.add(lane);
  }

  // Grass blades, thickest along the water, leaning out over it.
  buildGrass(count) {
    const blade = new THREE.BufferGeometry();
    const segs = 4, pos = [], nrm = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, w = 0.0068 * (1 - t * 0.82);
      const lean = t * t * 0.3;
      pos.push(-w, t, lean, w, t, lean);
      nrm.push(0, 1, 0.3, 0, 1, 0.3);
    }
    for (let i = 0; i < segs; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    blade.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    blade.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    blade.setIndex(idx);
    const mat = translucent(new THREE.MeshStandardMaterial({ roughness: 0.75, side: THREE.DoubleSide }), 0.55, 'grass', true);
    const mesh = new THREE.InstancedMesh(blade, mat, count);
    const r = rng(3);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
    const col = new THREE.Color();
    let n = 0, guard = 0;
    while (n < count && guard++ < count * 12) {
      const s = -1 + r() * (WORLD.CULVERT_S + 0.8);
      const side = r() < 0.5 ? -1 : 1;
      const hw = halfWidth(s), nc = centerOffset(s);
      const reach = side < 0 ? 2.1 : 1.0;
      const d = 0.015 + Math.pow(r(), 1.9) * reach;
      const nn = nc + side * (hw + d);
      if (side > 0 && nn > LANE.n0 - 0.02 && nn < LANE.n1 + 0.02 && r() > 0.05) continue;
      if (Math.abs(s - 0.95) < 0.2 && Math.abs(nn) < 0.8) continue;
      const y = groundHeight(s, nn);
      // keep clumps in clusters: patchy, not a lawn
      if (fbm(s * 2.3, nn * 2.3, 2) < -0.12 && d > 0.1) continue;
      toWorld(s, nn, w2);
      const nearWater = d < 0.14;
      const h = (nearWater ? 0.09 + r() * 0.17 : 0.07 + r() * 0.15);
      p.set(w2[0], y - 0.008, w2[1]);
      // bank grass leans toward the stream
      const th = heading(s);
      const towards = nearWater ? (side > 0 ? th - Math.PI / 2 : th + Math.PI / 2) + (r() - 0.5) * 1.2 : r() * Math.PI * 2;
      e.set((r() - 0.5) * 0.5, towards, (r() - 0.5) * 0.5);
      q.setFromEuler(e);
      sc.set(1, h, 1);
      m4.compose(p, q, sc);
      mesh.setMatrixAt(n, m4);
      const dry = Math.pow(r(), 2.2);
      col.setRGB(0.2 + dry * 0.5, 0.31 + dry * 0.17, 0.08 + dry * 0.06).multiplyScalar(0.5 + r() * 0.28);
      mesh.setColorAt(n, col);
      n++;
    }
    mesh.count = n;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  buildSusuki() {
    const r = rng(9);
    const spots = [];
    for (const [s0, side, k] of [[3.0, -1, 8], [6.6, 1, 6], [9.5, -1, 9], [13.2, 1, 7], [16.5, -1, 9], [20.4, 1, 6], [23.9, -1, 8], [25.4, 1, 5]]) {
      for (let i = 0; i < k; i++) {
        const s = s0 + (r() - 0.5) * 1.1;
        const nn = centerOffset(s) + side * (halfWidth(s) + (side > 0 ? LANE.n1 - 0.2 + r() * 0.5 : 0.12 + r() * 0.6));
        toWorld(s, nn, w2);
        spots.push([w2[0], groundHeight(s, nn), w2[1], 0.62 + r() * 0.42, r()]);
      }
    }
    const stem = new THREE.BufferGeometry();
    const sp = [], sn = [];
    const segs = 6;
    for (let i = 0; i <= segs; i++) { const t = i / segs; const w = 0.003 * (1 - t * 0.6); sp.push(-w, t, 0, w, t, 0); sn.push(0, 0.6, 1, 0, 0.6, 1); }
    const si = [];
    for (let i = 0; i < segs; i++) { const a = i * 2; si.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    stem.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    stem.setAttribute('normal', new THREE.Float32BufferAttribute(sn, 3));
    stem.setIndex(si);
    const plumeGeo = new THREE.BufferGeometry();
    const pp = [], pu = [], pn = [], pi = [];
    for (let k = 0; k < 2; k++) {
      const a = k * Math.PI / 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      const b = pp.length / 3;
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const w = (u - 0.5) * 0.11, y = 0.78 + v * 0.36;
        const lean = v * v * 0.08;
        pp.push(w * cx + lean, y, w * cz);
        pu.push(u, v);
        pn.push(0, 0.5, 1);
      }
      pi.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    plumeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
    plumeGeo.setAttribute('uv', new THREE.Float32BufferAttribute(pu, 2));
    plumeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(pn, 3));
    plumeGeo.setIndex(pi);
    const stemMat = translucent(new THREE.MeshStandardMaterial({ color: 0x7d7a3e, roughness: 0.7, side: THREE.DoubleSide }), 2.2, 'susuki-stem');
    const plumeMat = translucent(new THREE.MeshStandardMaterial({ map: makePlumeTexture(), color: 0xf3e6cf, roughness: 0.9, side: THREE.DoubleSide, alphaTest: 0.08 }), 2.2, 'susuki-plume');
    const stems = new THREE.InstancedMesh(stem, stemMat, spots.length);
    const plumes = new THREE.InstancedMesh(plumeGeo, plumeMat, spots.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    spots.forEach(([x, y, z, h, rr], i) => {
      e.set((rr - 0.5) * 0.25, rr * 6.28, (rr - 0.4) * 0.3);
      q.setFromEuler(e);
      m4.compose(new THREE.Vector3(x, y - 0.02, z), q, new THREE.Vector3(1, h, 1));
      stems.setMatrixAt(i, m4);
      plumes.setMatrixAt(i, m4);
    });
    stems.frustumCulled = plumes.frustumCulled = false;
    this.group.add(stems, plumes);
  }

  buildHiganbana() {
    // red spider lilies: stem + six recurved petals + long stamens, as one vertex-coloured geometry
    const pos = [], col = [], idx = [];
    const red = [0.62, 0.035, 0.03], deep = [0.38, 0.02, 0.02], green = [0.16, 0.24, 0.07];
    const ribbon = (pts, width, c0, c1) => {
      const b = pos.length / 3;
      for (let i = 0; i < pts.length; i++) {
        const [x, y, z] = pts[i];
        const t = i / (pts.length - 1);
        const w = width * Math.sin(Math.min(1, t * 1.2 + 0.08) * Math.PI) + width * 0.15;
        const c = [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
        pos.push(x - w * 0.5, y, z, x + w * 0.5, y, z);
        col.push(...c, ...c);
      }
      for (let i = 0; i < pts.length - 1; i++) { const a = b + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    };
    const H = 0.27;
    ribbon([[0, 0, 0], [0.004, H * 0.5, 0], [0, H, 0]], 0.0055, green, green);
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const rr = 0.009 + t * 0.038, yy = H + 0.008 + Math.sin(t * Math.PI * 0.9) * 0.019 - t * t * 0.023;
        pts.push([ca * rr, yy, sa * rr]);
      }
      ribbon(pts, 0.009, deep, red);
      const st = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const rr = 0.008 + t * 0.056, yy = H + 0.008 + t * 0.052 - t * t * 0.015;
        st.push([Math.cos(a + 0.4) * rr, yy, Math.sin(a + 0.4) * rr]);
      }
      ribbon(st, 0.002, red, [0.7, 0.08, 0.05]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = translucent(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), 1.4, 'higanbana', true);      // red like a maple leaf, so never left standing in front of one
    const r = rng(21);
    const places = [];
    for (const [s0, side, k] of [[2.9, 1, 7], [5.3, -1, 6], [8.6, 1, 8], [12.2, -1, 9], [17.1, 1, 8], [19.9, -1, 7], [24.6, 1, 8]]) {
      for (let i = 0; i < k; i++) {
        const s = s0 + (r() - 0.5) * 0.7;
        const nn = centerOffset(s) + side * (halfWidth(s) + 0.05 + r() * 0.16);
        toWorld(s, nn, w2);
        places.push([w2[0], groundHeight(s, nn), w2[1], 0.8 + r() * 0.4, r()]);
      }
    }
    const inst = new THREE.InstancedMesh(geo, mat, places.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    places.forEach(([x, y, z, sc, rr], i) => {
      e.set((rr - 0.5) * 0.2, rr * 6.28, (rr - 0.5) * 0.2);
      q.setFromEuler(e);
      m4.compose(new THREE.Vector3(x, y - 0.01, z), q, new THREE.Vector3(sc, sc, sc));
      inst.setMatrixAt(i, m4);
    });
    inst.frustumCulled = false;
    this.group.add(inst);
  }

  // Leaves already down: on the lane and caught along the banks.
  buildFallenLeaves(tier) {
    const count = Math.round(tier.grass * 0.09);
    const geo = new THREE.BufferGeometry();
    const pos = [], nrm = [];
    const N = 10;
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2, b = (i + 1) / N * Math.PI * 2;
      const R = (t) => 0.013 * (0.62 + 0.38 * Math.cos(t * 2));
      pos.push(0, 0.002, 0, Math.cos(a) * R(a), 0.0015 * Math.sin(a * 3), Math.sin(a) * R(a), Math.cos(b) * R(b), 0.0015 * Math.sin(b * 3), Math.sin(b) * R(b));
      nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.82, side: THREE.DoubleSide }), count);
    const r = rng(101);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const col = new THREE.Color();
    const palette = [[0.62, 0.2, 0.06], [0.72, 0.42, 0.08], [0.45, 0.26, 0.09], [0.32, 0.17, 0.07], [0.72, 0.56, 0.12]];
    let n = 0;
    for (let i = 0; i < count * 3 && n < count; i++) {
      const s = -0.5 + r() * (WORLD.CULVERT_S + 0.3);
      const nn = r() < 0.72 ? LANE.n0 - 0.05 + r() * (LANE.n1 - LANE.n0 + 0.3) : -halfWidth(s) - r() * 1.3;
      if (fbm(s * 1.4, nn * 1.4, 2) < -0.05) continue;
      toWorld(s, nn, w2);
      p.set(w2[0], groundHeight(s, nn) + 0.003, w2[1]);
      e.set((r() - 0.5) * 0.4, r() * 6.28, (r() - 0.5) * 0.4);
      q.setFromEuler(e);
      const k = 0.7 + r() * 0.8;
      sc.set(k, k, k * (0.7 + r() * 0.5));
      m4.compose(p, q, sc);
      mesh.setMatrixAt(n, m4);
      const c = palette[Math.floor(r() * palette.length)];
      col.setRGB(c[0], c[1], c[2]).multiplyScalar(0.55 + r() * 0.5);
      mesh.setColorAt(n, col);
      n++;
    }
    mesh.count = n;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  // A tall bamboo stand on the hill side.
  buildBamboo() {
    const r = rng(55);
    const culms = [];
    for (let i = 0; i < 90; i++) {
      const s = -4 + r() * (WORLD.L + 8);
      const nn = -(1.5 + Math.pow(r(), 0.8) * 5.5);
      if (fbm(s * 0.18, 3.1, 2) < -0.08) continue;
      toWorld(s, nn, w2);
      if (Math.abs(nearest(w2[0], w2[1], 12).n) < 1.2) continue;
      culms.push({ x: w2[0], z: w2[1], y: groundHeight(s, nn), h: 5.5 + r() * 3.5, rad: 0.018 + r() * 0.018, lean: (r() - 0.5) * 0.12, yaw: r() * 6.28 });
    }
    const geo = new THREE.CylinderGeometry(0.72, 1, 1, 7, 1, true);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x7f8f3f, roughness: 0.42 });
    const inst = new THREE.InstancedMesh(geo, mat, culms.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    culms.forEach((c, i) => {
      e.set(c.lean, c.yaw, c.lean * 0.6);
      q.setFromEuler(e);
      m4.compose(new THREE.Vector3(c.x, c.y - 0.05, c.z), q, new THREE.Vector3(c.rad, c.h, c.rad));
      inst.setMatrixAt(i, m4);
    });
    inst.castShadow = true;
    inst.frustumCulled = false;
    this.group.add(inst);
    // foliage: drooping sprays high on each culm
    const cards = [];
    for (const c of culms) {
      const k = 9 + Math.floor(r() * 7);
      for (let i = 0; i < k; i++) {
        const t = 0.45 + r() * 0.55;
        cards.push({ x: c.x + (r() - 0.5) * 1.1 * (0.3 + t) + c.lean * c.h * t, y: c.y + c.h * t, z: c.z + (r() - 0.5) * 1.1 * (0.3 + t), s: 0.5 + r() * 0.6, rot: r() });
      }
    }
    this.addFoliage(cards, 'bamboo', ['#5d7a2c', '#7c9334', '#476a26', '#92a43b'], 0.55);
  }

  // Foliage sprays: textured crossing cards, instanced.
  addFoliage(cards, key, colors, aspect) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const r = rng(key.length * 77);
    g.clearRect(0, 0, 128, 128);
    for (let i = 0; i < 190; i++) {
      const a = r() * 6.28, d = Math.pow(r(), 0.6) * 58;
      const x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d;
      g.save(); g.translate(x, y); g.rotate(r() * 6.28);
      g.fillStyle = colors[Math.floor(r() * colors.length)];
      g.beginPath(); g.ellipse(0, 0, 6 * aspect + 2, 2.2 + r() * 2, 0, 0, 6.28); g.fill();
      g.restore();
    }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const pos = [], uv = [], nrm = [], idx = [];
    for (let k = 0; k < 2; k++) {
      const a = k * Math.PI / 2, cx = Math.cos(a), cz = Math.sin(a);
      const b = pos.length / 3;
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { pos.push((u - 0.5) * cx, v - 0.5, (u - 0.5) * cz); uv.push(u, v); nrm.push(0, 0.8, 0.6); }
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    const mat = translucent(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, color: 0xb8b0a0, side: THREE.DoubleSide, alphaTest: 0.35 }), 0.5, `foliage-${key}`);
    const inst = new THREE.InstancedMesh(geo, mat, cards.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const tint = new THREE.Color();
    cards.forEach((c, i) => {
      e.set((c.rot - 0.5) * 1.1, c.rot * 12.56, (c.rot * 3 % 1 - 0.5) * 1.1);
      q.setFromEuler(e);
      m4.compose(new THREE.Vector3(c.x, c.y, c.z), q, new THREE.Vector3(c.s, c.s, c.s));
      inst.setMatrixAt(i, m4);
      tint.setRGB(1, 1, 1).multiplyScalar(0.72 + c.rot * 0.45);
      inst.setColorAt(i, tint);
    });
    inst.castShadow = true;
    inst.frustumCulled = false;
    this.group.add(inst);
  }

  // Autumn trees beside the lane: a branching trunk with sprays of coloured leaves.
  buildTrees() {
    const bark = new THREE.MeshStandardMaterial({ color: 0x3a2d24, roughness: 0.95 });
    const r = rng(404);
    const sets = {
      kaki: { colors: ['#7f6a24', '#a97a1f', '#c5642a', '#5f6626'], list: [] },
      momiji: { colors: ['#c0361c', '#de5a22', '#e98a2c', '#9e2b18'], list: [] },
      keyaki: { colors: ['#c79a2a', '#a97c22', '#8c7a2a', '#d9b23a'], list: [] },
    };
    const fruitPos = [];
    const place = [[3.4, 3.1, 'kaki', 4.2], [8.3, 2.9, 'momiji', 3.8], [13.0, -3.0, 'momiji', 4.2], [14.3, 3.4, 'keyaki', 5.5], [21.2, 3.0, 'kaki', 4.0], [24.5, -2.8, 'momiji', 3.6], [19.0, 3.8, 'momiji', 4.0], [0.2, 3.3, 'keyaki', 5.0], [27.9, 2.8, 'keyaki', 5.2]];
    for (const [s, nn, kind, height] of place) {
      toWorld(s, nn, w2);
      const y0 = groundHeight(s, nn);
      const base = new THREE.Vector3(w2[0], y0 - 0.05, w2[1]);
      const tips = [];
      const branch = (from, dir, len, rad, depth) => {
        const to = from.clone().addScaledVector(dir, len);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.68, rad, len, 7), bark);
        m.position.copy(from).lerp(to, 0.5);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        m.castShadow = true;
        this.group.add(m);
        if (depth === 0) { tips.push(to); return; }
        const kids = depth > 2 ? 3 : 2;
        for (let i = 0; i < kids; i++) {
          const d = dir.clone().add(new THREE.Vector3((r() - 0.5) * 1.3, 0.05 + r() * 0.35, (r() - 0.5) * 1.3)).normalize();
          branch(to, d, len * (0.62 + r() * 0.16), rad * 0.62, depth - 1);
        }
        if (depth <= 2) tips.push(to);
      };
      branch(base, new THREE.Vector3((r() - 0.5) * 0.14, 1, (r() - 0.5) * 0.14).normalize(), height * 0.36, 0.05 + height * 0.022, 3);
      for (const t of tips) {
        const k = 5 + Math.floor(r() * 4);
        for (let i = 0; i < k; i++) {
          sets[kind].list.push({ x: t.x + (r() - 0.5) * 1.1, y: t.y + (r() - 0.4) * 0.8, z: t.z + (r() - 0.5) * 1.1, s: 0.55 + r() * 0.55, rot: r() });
        }
        if (kind === 'kaki') for (let i = 0; i < 2; i++) if (r() < 0.8) fruitPos.push([t.x + (r() - 0.5) * 0.7, t.y + (r() - 0.6) * 0.4, t.z + (r() - 0.5) * 0.7]);
      }
    }
    for (const [key, v] of Object.entries(sets)) if (v.list.length) this.addFoliage(v.list, key, v.colors, 0.8);
    const fruit = new THREE.InstancedMesh(new THREE.SphereGeometry(0.038, 10, 8), new THREE.MeshStandardMaterial({ color: 0xe0701a, roughness: 0.38 }), fruitPos.length);
    const m4 = new THREE.Matrix4();
    fruitPos.forEach(([x, y, z], i) => { m4.makeScale(1, 0.86, 1).setPosition(x, y, z); fruit.setMatrixAt(i, m4); });
    fruit.castShadow = true;
    fruit.frustumCulled = false;
    this.group.add(fruit);
  }

  // A small stone jizo on the far edge of the lane, with a red bib someone keeps tidy.
  buildJizo() {
    const s = 12.6;
    const nn = LANE.n1 + 0.14;
    toWorld(s, nn, w2);
    const y = groundHeight(s, nn);
    const stone = new THREE.MeshStandardMaterial({ color: 0x8e8a7f, roughness: 0.95 });
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.05, 9), stone);
    base.position.y = 0.025;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.1, 5, 10), stone);
    body.position.y = 0.135; body.scale.set(1, 1, 0.85);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), stone);
    head.position.y = 0.268;
    const bib = new THREE.Mesh(new THREE.ConeGeometry(0.066, 0.1, 10, 1, true, -1.4, 2.8), new THREE.MeshStandardMaterial({ color: 0xb12a1e, roughness: 0.85, side: THREE.DoubleSide }));
    bib.position.set(0, 0.17, 0.004); bib.rotation.x = Math.PI;
    bib.rotation.y = Math.PI;
    g.add(base, body, head, bib);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.position.set(w2[0], y - 0.01, w2[1]);
    // facing the lane and the stream
    g.rotation.y = heading(s) - Math.PI / 2;
    this.group.add(g);
  }

  // A few old stakes and a sagging wire on the field side of the lane.
  buildFence() {
    const wood = new THREE.MeshStandardMaterial({ color: 0x4e4133, roughness: 0.95 });
    const pts = [];
    for (let s = 3; s < WORLD.L - 3; s += 1.9) {
      const nn = LANE.n1 + 0.5;
      toWorld(s, nn, w2);
      const y = groundHeight(s, nn);
      const h = 0.62 + (Math.sin(s * 3.1) * 0.5 + 0.5) * 0.1;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, h, 7), wood);
      m.position.set(w2[0], y + h / 2 - 0.04, w2[1]);
      m.rotation.z = Math.sin(s * 5.1) * 0.05;
      m.castShadow = true;
      this.group.add(m);
      pts.push(new THREE.Vector3(w2[0], y + h - 0.08, w2[1]));
    }
    const wire = new THREE.MeshBasicMaterial({ color: 0x2a2520 });
    for (let i = 0; i < pts.length - 1; i++) {
      const c = [];
      for (let k = 0; k <= 8; k++) { const t = k / 8; const p = pts[i].clone().lerp(pts[i + 1], t); p.y -= 0.05 * 4 * t * (1 - t); c.push(p); }
      this.group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(c), 10, 0.0022, 4), wire));
    }
  }

  // Layered ridges: a low wooded line where the land ends, hazier hills behind it.
  buildFarland() {
    toWorld(WORLD.L / 2, 0, w2);
    const cx0 = w2[0], cz0 = w2[1];
    const ring = (R, y0, base, range, freq, oct, footCol, topCol, crowns = 0) => {
      const seg = crowns ? 1400 : 300, pos = [], col = [], idx = [];
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI * 2;
        let h = base + range * (fbm(Math.cos(a) * freq + R, Math.sin(a) * freq, oct) * 0.5 + 0.5);
        // a line of rounded tree crowns instead of a jagged ridge
        if (crowns) {
          const warp = 14 * fbm(Math.cos(a) * 11, Math.sin(a) * 11, 3);
          const big = 0.6 + 0.8 * (fbm(Math.cos(a) * 20 + 3, Math.sin(a) * 20, 2) * 0.5 + 0.5);
          h += big * 1.5 * Math.sqrt(Math.abs(Math.sin(a * crowns + warp))) + 0.5 * Math.sqrt(Math.abs(Math.sin(a * crowns * 2.7 + warp * 2)));
        }
        const x = cx0 + Math.cos(a) * R, z = cz0 + Math.sin(a) * R;
        pos.push(x, y0, z, x, y0 + h, z);
        col.push(...footCol, ...topCol);
      }
      for (let i = 0; i < seg; i++) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      this.group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide })));
    };
    ring(240, -8, 16, 26, 4.5, 6, [0.5, 0.47, 0.44], [0.4, 0.43, 0.46]);    // far hills, in haze
    ring(150, -8, 9, 13, 9, 6, [0.3, 0.3, 0.24], [0.26, 0.29, 0.27]);       // nearer hills
    ring(62, -6, 4, 3, 7, 2, [0.1, 0.1, 0.06], [0.2, 0.17, 0.08], 90);     // the wood at the edge of the fields
  }

  buildDragonflies() {
    const body = new THREE.MeshStandardMaterial({ color: 0xc8361c, roughness: 0.4 });
    const wingMat = new THREE.MeshStandardMaterial({ color: 0xe8eef0, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
    this.dragonflies = [];
    const r = rng(77);
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0035, 0.042, 6), body);
      tail.rotation.x = Math.PI / 2; tail.position.z = -0.018;
      const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 8, 6), body);
      thorax.scale.set(1, 1, 1.4); thorax.position.z = 0.008;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 8, 6), body);
      head.position.z = 0.018;
      g.add(tail, thorax, head);
      const wings = [];
      for (const [zz, len] of [[0.01, 0.034], [0.002, 0.031]]) for (const side of [-1, 1]) {
        const wg = new THREE.PlaneGeometry(len, 0.008); wg.translate(len / 2, 0, 0); wg.rotateX(-Math.PI / 2);
        const w = new THREE.Mesh(wg, wingMat);
        w.position.set(0, 0.002, zz); w.scale.x = side;
        g.add(w); wings.push(w);
      }
      g.userData = { wings, target: new THREE.Vector3(), timer: 0, seed: r() * 100, vel: new THREE.Vector3() };
      toWorld(3, 0, w2);
      g.position.set(w2[0], 1.4, w2[1]);
      this.group.add(g);
      this.dragonflies.push(g);
    }
  }

  updateDragonflies(time, focus) {
    if (!this.lastDfTime) this.lastDfTime = time;
    const dt = Math.min(0.05, Math.max(0, time - this.lastDfTime));
    this.lastDfTime = time;
    for (const d of this.dragonflies) {
      const u = d.userData;
      u.timer -= dt;
      if (u.timer <= 0 || d.position.distanceTo(focus) > 2.5) {
        // hover, then dart to a new spot near what the player is watching
        u.target.set(focus.x + (Math.random() - 0.5) * 1.6, focus.y + 0.25 + Math.random() * 0.35, focus.z + 0.5 + Math.random() * 1.3);
        u.timer = 0.6 + Math.random() * 2.2;
      }
      const to = u.target.clone().sub(d.position);
      u.vel.addScaledVector(to, dt * 9).multiplyScalar(Math.exp(-dt * 5));
      d.position.addScaledVector(u.vel, dt);
      d.position.y += Math.sin(time * 9 + u.seed) * 0.0008;
      if (u.vel.lengthSq() > 0.02) d.rotation.y = Math.atan2(u.vel.x, u.vel.z);
      const flap = Math.sin(time * 85 + u.seed) * 0.35;
      u.wings.forEach((w, i) => { w.rotation.z = (i % 2 ? -1 : 1) * flap; });
    }
    void RIVALS;
  }
}
