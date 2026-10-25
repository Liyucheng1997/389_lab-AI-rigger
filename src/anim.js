// 动画描述（AI 输出的 JSON）→ THREE.AnimationClip
//
// {
//   "name": "wave", "duration": 4, "loop": true, "bpm": 120,
//   "interpolation": "smooth" | "linear",
//   "keyframes": [ { "t": 0, "pose": { "leftUpperArm": [x, y, z] }, "root": [x, y, z], "ease": "linear" } ],
//   "layers": [ { "bone": "hips", "axis": "y", "amp": 8, "period": 1, "phase": 0, "from": 0, "to": 4,
//                 "fade": 0.3, "wave": "sine" | "bounce" | "triangle", "channel": "rotation" | "position" } ]
// }
// pose 的角度单位是度，是相对静止姿势的局部欧拉角（XYZ 顺序）；root 是根骨骼位移，单位为「角色身高」。
// 每根骨骼独立插值：只在出现过它的关键帧之间插值，未出现过的骨骼保持静止（再叠加 layers）。
import * as THREE from 'three';

const FPS = 30;
const DEG = Math.PI / 180;

function resolveBoneName(name, boneMap) {
  if (boneMap.has(name)) return name;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(name);
  for (const k of boneMap.keys()) if (norm(k) === n) return k;
  return null;
}

/** 校验并规范化，返回 { spec, warnings } */
export function normalizeSpec(raw, rig) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') throw new Error('动画 JSON 不是对象');
  const spec = {
    name: String(raw.name || 'animation').slice(0, 60),
    duration: Math.min(600, Math.max(0.1, Number(raw.duration) || 0)),
    loop: raw.loop !== false,
    bpm: raw.bpm ? Number(raw.bpm) : undefined,
    interpolation: raw.interpolation === 'linear' ? 'linear' : 'smooth',
    keyframes: [],
    layers: [],
    notes: raw.notes,
  };
  const unknown = new Set();
  const kfs = Array.isArray(raw.keyframes) ? raw.keyframes : [];
  let maxT = 0;
  for (const k of kfs) {
    const t = Number(k.t ?? k.time);
    if (!Number.isFinite(t)) continue;
    maxT = Math.max(maxT, t);
    const pose = {};
    for (const [bn, v] of Object.entries(k.pose || {})) {
      const name = resolveBoneName(bn, rig.boneMap);
      if (!name) { unknown.add(bn); continue; }
      const arr = Array.isArray(v) ? v : [v?.x, v?.y, v?.z];
      pose[name] = [0, 1, 2].map((i) => Number(arr[i]) || 0);
    }
    const kf = { t, pose };
    if (Array.isArray(k.root)) kf.root = [0, 1, 2].map((i) => Number(k.root[i]) || 0);
    if (k.ease === 'linear' || k.ease === 'step') kf.ease = k.ease;
    spec.keyframes.push(kf);
  }
  spec.keyframes.sort((a, b) => a.t - b.t);
  if (!spec.duration) spec.duration = Math.max(maxT, 1);
  for (const l of Array.isArray(raw.layers) ? raw.layers : []) {
    const channel = l.channel === 'position' ? 'position' : 'rotation';
    let bone = channel === 'position' ? rig.root.name : resolveBoneName(String(l.bone || ''), rig.boneMap);
    if (!bone) { unknown.add(l.bone); continue; }
    const axis = ['x', 'y', 'z'].includes(l.axis) ? l.axis : 'y';
    let period = Number(l.period) || 0;
    if (!period && l.beats && spec.bpm) period = (Number(l.beats) * 60) / spec.bpm;
    if (!period) period = 1;
    spec.layers.push({
      bone, channel, axis,
      amp: Number(l.amp) || 0,
      period,
      phase: Number(l.phase) || 0,
      from: Number.isFinite(Number(l.from)) ? Number(l.from) : 0,
      to: Number.isFinite(Number(l.to)) ? Number(l.to) : spec.duration,
      fade: Math.max(0, Number(l.fade) || 0),
      wave: ['bounce', 'triangle'].includes(l.wave) ? l.wave : 'sine',
    });
  }
  if (unknown.size) warnings.push(`忽略了不存在的骨骼：${[...unknown].join(', ')}`);
  if (!spec.keyframes.length && !spec.layers.length) warnings.push('动画里没有关键帧也没有 layers');
  return { spec, warnings };
}

// 三次 Hermite（Catmull-Rom 切线，支持非均匀时间、循环）
function sampleTrack(keys, t, loop, duration, smooth) {
  const n = keys.length;
  if (n === 1) return keys[0].v;
  let tt = t;
  if (loop) {
    const span = duration;
    // 循环时首尾相接：把最后一帧之后的区间连到「第一帧 + duration」
    if (tt < keys[0].t) tt += span;
  } else {
    if (tt <= keys[0].t) return keys[0].v;
    if (tt >= keys[n - 1].t) return keys[n - 1].v;
  }
  const get = (i) => {
    if (!loop) return keys[Math.min(n - 1, Math.max(0, i))];
    const m = ((i % n) + n) % n;
    const wrap = Math.floor(i / n);
    return { t: keys[m].t + wrap * duration, v: keys[m].v, ease: keys[m].ease };
  };
  let i = 0;
  while (i < n - 1 && keys[i + 1].t <= tt) i++;
  const k0 = get(i);
  const k1 = get(i + 1);
  const dt = k1.t - k0.t;
  if (dt <= 1e-6) return k1.v;
  const u = (tt - k0.t) / dt;
  if (k0.ease === 'step') return k0.v;
  if (!smooth || k0.ease === 'linear') return k0.v.map((a, c) => a + (k1.v[c] - a) * u);
  const km = get(i - 1);
  const kp = get(i + 2);
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return k0.v.map((a, c) => {
    const b = k1.v[c];
    const m0 = (km === k0 || (!loop && i === 0)) ? (b - a) / dt : (b - km.v[c]) / Math.max(1e-6, k1.t - km.t);
    const m1 = (kp === k1 || (!loop && i + 1 >= n - 1)) ? (b - a) / dt : (kp.v[c] - a) / Math.max(1e-6, kp.t - k0.t);
    return h00 * a + h10 * dt * m0 + h01 * b + h11 * dt * m1;
  });
}

function layerValue(l, t) {
  if (t < l.from || t > l.to) return 0;
  const x = ((t - l.from) / l.period + l.phase) * Math.PI * 2;
  let w;
  if (l.wave === 'bounce') w = Math.abs(Math.sin(x / 2));
  else if (l.wave === 'triangle') w = (2 / Math.PI) * Math.asin(Math.sin(x));
  else w = Math.sin(x);
  let env = 1;
  if (l.fade > 0) env = Math.min(1, (t - l.from) / l.fade, (l.to - t) / l.fade);
  return l.amp * w * Math.max(0, env);
}

export function buildClip(spec, rig) {
  const frames = Math.max(2, Math.round(spec.duration * FPS) + 1);
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = (f / (frames - 1)) * spec.duration;
  const smooth = spec.interpolation !== 'linear';

  const rotKeys = new Map();
  const rootKeys = [];
  for (const kf of spec.keyframes) {
    for (const [bone, v] of Object.entries(kf.pose)) {
      if (!rotKeys.has(bone)) rotKeys.set(bone, []);
      rotKeys.get(bone).push({ t: kf.t, v, ease: kf.ease });
    }
    if (kf.root) rootKeys.push({ t: kf.t, v: kf.root, ease: kf.ease });
  }
  const layerBones = new Set(spec.layers.filter((l) => l.channel === 'rotation').map((l) => l.bone));
  const tracks = [];
  const e = new THREE.Euler(0, 0, 0, 'XYZ');
  const q = new THREE.Quaternion();
  const prev = new THREE.Quaternion();

  for (const bone of new Set([...rotKeys.keys(), ...layerBones])) {
    const keys = rotKeys.get(bone) || [{ t: 0, v: [0, 0, 0] }];
    const layers = spec.layers.filter((l) => l.channel === 'rotation' && l.bone === bone);
    const values = new Float32Array(frames * 4);
    for (let f = 0; f < frames; f++) {
      const t = times[f];
      const v = [...sampleTrack(keys, t, spec.loop, spec.duration, smooth)];
      for (const l of layers) v['xyz'.indexOf(l.axis)] += layerValue(l, t);
      e.set(v[0] * DEG, v[1] * DEG, v[2] * DEG, 'XYZ');
      q.setFromEuler(e);
      if (f > 0 && q.dot(prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // 保持半球连续，避免插值翻转
      prev.copy(q);
      q.toArray(values, f * 4);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
  }

  const posLayers = spec.layers.filter((l) => l.channel === 'position');
  if (rootKeys.length || posLayers.length) {
    const rest = rig.rest.get(rig.root.name);
    const H = rig.height;
    const keys = rootKeys.length ? rootKeys : [{ t: 0, v: [0, 0, 0] }];
    const values = new Float32Array(frames * 3);
    for (let f = 0; f < frames; f++) {
      const t = times[f];
      const v = [...sampleTrack(keys, t, spec.loop, spec.duration, smooth)];
      for (const l of posLayers) v['xyz'.indexOf(l.axis)] += layerValue(l, t);
      values[f * 3] = rest.x + v[0] * H;
      values[f * 3 + 1] = rest.y + v[1] * H;
      values[f * 3 + 2] = rest.z + v[2] * H;
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${rig.root.name}.position`, times, values));
  }
  return new THREE.AnimationClip(spec.name, spec.duration, tracks);
}

export function specStats(spec) {
  const bones = new Set();
  for (const k of spec.keyframes) for (const b of Object.keys(k.pose)) bones.add(b);
  for (const l of spec.layers) bones.add(l.bone);
  return `${spec.duration.toFixed(1)}s · ${spec.keyframes.length} 关键帧 · ${spec.layers.length} 层 · ${bones.size} 骨骼`;
}

/** 不依赖 AI 的人形测试动作（骨骼名不匹配时自动忽略） */
export const PRESETS = {
  idle: {
    name: 'idle_breath', duration: 3, loop: true,
    keyframes: [{ t: 0, pose: { leftUpperArm: [0, 0, -72], rightUpperArm: [0, 0, 72], leftLowerArm: [0, -8, 0], rightLowerArm: [0, 8, 0] } }],
    layers: [
      { bone: 'chest', axis: 'x', amp: 2, period: 3 },
      { bone: 'spine', axis: 'z', amp: 1.2, period: 6 },
      { bone: 'head', axis: 'y', amp: 4, period: 6, phase: 0.25 },
    ],
  },
  wave: {
    name: 'wave', duration: 2.4, loop: true,
    keyframes: [
      { t: 0, pose: { rightUpperArm: [0, 0, 72], leftUpperArm: [0, 0, -72], rightLowerArm: [0, 0, 0] } },
      { t: 0.5, pose: { rightUpperArm: [0, 0, -40], rightLowerArm: [0, 0, -70] } },
      { t: 1.9, pose: { rightUpperArm: [0, 0, -40], rightLowerArm: [0, 0, -70] } },
      { t: 2.4, pose: { rightUpperArm: [0, 0, 72], rightLowerArm: [0, 0, 0] } },
    ],
    layers: [{ bone: 'rightLowerArm', axis: 'z', amp: 18, period: 0.45, from: 0.5, to: 1.9, fade: 0.15 }],
  },
};
