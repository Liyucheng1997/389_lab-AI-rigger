// 骨骼：关节定义、吸附居中、对称、自动蒙皮权重、构建 SkinnedMesh
//
// 约定：关节 = 空间中的点；骨骼以其起点关节命名，驱动「该关节 → 子关节」这一段。
// 所有骨骼的静止旋转都是单位旋转（局部轴 = 世界轴），动画里的欧拉角因此直接对应
// 「X=角色左方、Y=上、Z=前方」，便于 AI 推理。名字以 End 结尾的关节只是末端标记，不分配权重。
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const isEndJoint = (name) => /end$/i.test(name);

export function sanitizeName(name, used) {
  let n = String(name || 'joint').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'joint';
  if (used) {
    const base = n;
    let k = 2;
    while (used.has(n)) n = `${base}_${k++}`;
    used.add(n);
  }
  return n;
}

/** 左右名字互换；无法识别左右时返回 null */
export function mirrorName(name) {
  const rules = [
    [/left/g, 'right'], [/right/g, 'left'], [/Left/g, 'Right'], [/Right/g, 'Left'],
    [/LEFT/g, 'RIGHT'], [/RIGHT/g, 'LEFT'],
  ];
  for (const [re, rep] of rules) if (re.test(name)) return name.replace(re, rep);
  const m = /^(.*[_.])([LlRr])$/.exec(name) || /^([LlRr])([_.].*)$/.exec(name);
  if (m) {
    const swap = { L: 'R', R: 'L', l: 'r', r: 'l' };
    return /^(.*[_.])([LlRr])$/.test(name) ? m[1] + swap[m[2]] : swap[m[1]] + m[2];
  }
  return null;
}

// ---------- 人形模板（AI 不可用时的兜底） ----------
export function humanoidTemplate(asset) {
  const H = asset.height;
  const halfW = Math.max(asset.size.x / 2, 0.2 * H);
  const sh = 0.1 * H;
  const armX = (f) => sh + (halfW - sh) * f;
  const j = [
    ['hips', null, 0, 0.53, 0],
    ['spine', 'hips', 0, 0.6, 0],
    ['chest', 'spine', 0, 0.7, 0],
    ['neck', 'chest', 0, 0.83, 0],
    ['head', 'neck', 0, 0.87, 0],
    ['headEnd', 'head', 0, 0.99, 0],
  ];
  for (const [side, s] of [['left', 1], ['right', -1]]) {
    const S = (n) => side + n;
    j.push(
      [S('Shoulder'), 'chest', s * 0.025 * H, 0.8, 0],
      [S('UpperArm'), S('Shoulder'), s * sh, 0.81, 0],
      [S('LowerArm'), S('UpperArm'), s * armX(0.45), 0.81, 0],
      [S('Hand'), S('LowerArm'), s * armX(0.83), 0.81, 0],
      [S('HandEnd'), S('Hand'), s * armX(0.98), 0.81, 0],
      [S('UpperLeg'), 'hips', s * 0.055 * H, 0.5, 0],
      [S('LowerLeg'), S('UpperLeg'), s * 0.06 * H, 0.28, 0],
      [S('Foot'), S('LowerLeg'), s * 0.065 * H, 0.055, 0],
      [S('Toes'), S('Foot'), s * 0.065 * H, 0.018, 0.08 * H],
      [S('ToesEnd'), S('Toes'), s * 0.065 * H, 0.012, 0.13 * H],
    );
  }
  return j.map(([name, parent, x, y, z]) => ({
    name, parent, pos: new THREE.Vector3(x, y * H, z),
  }));
}

// ---------- 网格加速结构 ----------
export function buildBVH(asset) {
  const geos = asset.parts.map((p) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', p.geometry.attributes.position.clone());
    if (p.geometry.index) g.setIndex(p.geometry.index.clone());
    else g.setIndex([...Array(p.geometry.attributes.position.count).keys()]);
    return g;
  });
  const merged = geos.length > 1 ? mergeGeometries(geos) : geos[0];
  return new MeshBVH(merged);
}

const _ray = new THREE.Ray();

/**
 * 沿 -Z 方向穿过 (x,y) 的「体内」区间。用面法线判断进入/离开并计数，
 * 这样互相穿插的多个壳（躯干里的骨盆、身体外的衣服）会合并成并集，而不是被错误配对。
 */
function zIntervals(bvh, asset, x, y) {
  _ray.origin.set(x, y, asset.box.max.z + 1);
  _ray.direction.set(0, 0, -1);
  const hits = bvh.raycast(_ray, THREE.DoubleSide)
    .map((h) => ({ z: _ray.origin.z - h.distance, enter: h.face ? h.face.normal.z > 0 : true }))
    .sort((a, b) => b.z - a.z);
  const out = [];
  let depth = 0;
  let start = 0;
  for (const h of hits) {
    if (h.enter) {
      if (depth === 0) start = h.z;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && start - h.z > 1e-5 * asset.height) out.push([h.z, start]);
    }
  }
  if (!out.length && hits.length >= 2) out.push([hits[hits.length - 1].z, hits[0].z]); // 法线不可靠时退化为整体跨度
  return out;
}

function isInside(bvh, asset, p) {
  return zIntervals(bvh, asset, p.x, p.y).some(([a, b]) => p.z >= a && p.z <= b);
}

/**
 * 把关节吸附到网格内部：
 *  1) 深度：在正视图 (x,y) 处找穿过网格的厚度区间，取离 AI 给出深度最近的区间中点；
 *  2) 截面：在垂直于骨骼方向的平面内放射 12 条射线，向截面中心靠拢（四肢关节尤其受益）。
 */
export function refineJoints(joints, asset, bvh, { centerDepth = true, centerSection = true } = {}) {
  const H = asset.height;
  const byName = new Map(joints.map((j) => [j.name, j]));
  const children = new Map(joints.map((j) => [j.name, []]));
  for (const j of joints) if (j.parent && children.has(j.parent)) children.get(j.parent).push(j);

  if (centerDepth) {
    for (const j of joints) {
      const iv = zIntervals(bvh, asset, j.pos.x, j.pos.y);
      if (!iv.length) continue;
      let best = iv[0];
      let bestD = Infinity;
      for (const [a, b] of iv) {
        const d = j.pos.z >= a && j.pos.z <= b ? -1 : Math.min(Math.abs(j.pos.z - a), Math.abs(j.pos.z - b));
        // 同等距离时偏好更厚的区间（躯干而不是贴在前面的手）
        const score = d - (b - a) * 1e-3;
        if (score < bestD) { bestD = score; best = [a, b]; }
      }
      if (isEndJoint(j.name)) {
        // 末端标记只需在体积范围内，不强行居中
        j.pos.z = THREE.MathUtils.clamp(j.pos.z, best[0], best[1]);
      } else {
        j.pos.z = (best[0] + best[1]) / 2;
      }
    }
  }

  if (centerSection) {
    const dir = new THREE.Vector3();
    const u = new THREE.Vector3();
    const v = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    for (let pass = 0; pass < 2; pass++) {
      for (const j of joints) {
        if (isEndJoint(j.name)) continue;
        const kids = children.get(j.name);
        const parent = j.parent ? byName.get(j.parent) : null;
        if (kids.length === 1) dir.subVectors(kids[0].pos, j.pos);
        else if (parent && kids.length === 0) dir.subVectors(j.pos, parent.pos);
        else continue; // 分叉关节（髋、胸）保持深度居中的结果即可
        if (dir.lengthSq() < 1e-10) continue;
        dir.normalize();
        if (!isInside(bvh, asset, j.pos)) continue;
        u.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0).cross(dir).normalize();
        v.crossVectors(dir, u).normalize();
        const centroid = new THREE.Vector3();
        let n = 0;
        const N = 12;
        for (let k = 0; k < N; k++) {
          const a = (k / N) * Math.PI * 2;
          _ray.origin.copy(j.pos);
          _ray.direction.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
          const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, 0.25 * H);
          if (!hit) continue;
          centroid.add(tmp.copy(_ray.direction).multiplyScalar(hit.distance).add(j.pos));
          n++;
        }
        if (n < N * 0.75) continue;
        centroid.divideScalar(n);
        const move = tmp.subVectors(centroid, j.pos).multiplyScalar(0.7);
        const maxMove = 0.04 * H;
        if (move.length() > maxMove) move.setLength(maxMove);
        j.pos.add(move);
      }
    }
  }
  return joints;
}

/** 左右对称：成对关节镜像平均，中线关节 x 吸到 0 */
export function symmetrize(joints, asset) {
  const byName = new Map(joints.map((j) => [j.name, j]));
  const done = new Set();
  for (const j of joints) {
    if (done.has(j.name)) continue;
    const m = mirrorName(j.name);
    const o = m && byName.get(m);
    if (o) {
      const L = j.pos.x >= o.pos.x ? j : o;
      const R = L === j ? o : j;
      const x = (L.pos.x - R.pos.x) / 2;
      const y = (L.pos.y + R.pos.y) / 2;
      const z = (L.pos.z + R.pos.z) / 2;
      L.pos.set(x, y, z);
      R.pos.set(-x, y, z);
      done.add(j.name).add(o.name);
    } else if (Math.abs(j.pos.x) < 0.05 * asset.height) {
      j.pos.x = 0;
    }
  }
  return joints;
}

/** 保证关节表合法：名字唯一合法、父关节存在、恰好一个根、无环 */
export function normalizeJoints(list) {
  const used = new Set();
  const rename = new Map();
  const joints = list.map((j) => {
    const name = sanitizeName(j.name, used);
    rename.set(j.name, name);
    return { name, parent: j.parent ?? null, pos: j.pos.clone ? j.pos.clone() : new THREE.Vector3(...j.pos) };
  });
  for (const j of joints) j.parent = j.parent != null ? rename.get(j.parent) ?? null : null;
  const names = new Set(joints.map((j) => j.name));
  for (const j of joints) if (j.parent && !names.has(j.parent)) j.parent = null;
  // 断环
  const byName = new Map(joints.map((j) => [j.name, j]));
  for (const j of joints) {
    const seen = new Set([j.name]);
    let p = j.parent;
    while (p) {
      if (seen.has(p)) { j.parent = null; break; }
      seen.add(p);
      p = byName.get(p)?.parent;
    }
  }
  const roots = joints.filter((j) => !j.parent);
  if (roots.length > 1) {
    // 选最靠近质心、子孙最多的作为根，其他根挂到它下面
    const count = (n) => joints.filter((j) => j.parent === n).length;
    roots.sort((a, b) => count(b.name) - count(a.name));
    for (const r of roots.slice(1)) r.parent = roots[0].name;
  }
  // 父在前、子在后
  const order = [];
  const visit = (name) => {
    order.push(byName.get(name));
    for (const c of joints) if (c.parent === name) visit(c.name);
  };
  if (joints.length) visit(joints.find((j) => !j.parent).name);
  return order;
}

// ---------- 自动蒙皮 ----------
function weldVertices(pos, tol) {
  const map = new Map();
  const groupOf = new Uint32Array(pos.count);
  const reps = [];
  const inv = 1 / tol;
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * inv)},${Math.round(pos.getY(i) * inv)},${Math.round(pos.getZ(i) * inv)}`;
    let g = map.get(key);
    if (g === undefined) { g = reps.length; map.set(key, g); reps.push(i); }
    groupOf[i] = g;
  }
  return { groupOf, reps };
}

function buildAdjacency(geometry, groupOf, nGroups) {
  const sets = Array.from({ length: nGroups }, () => new Set());
  const idx = geometry.index;
  const triCount = idx ? idx.count / 3 : geometry.attributes.position.count / 3;
  for (let t = 0; t < triCount; t++) {
    const a = groupOf[idx ? idx.getX(t * 3) : t * 3];
    const b = groupOf[idx ? idx.getX(t * 3 + 1) : t * 3 + 1];
    const c = groupOf[idx ? idx.getX(t * 3 + 2) : t * 3 + 2];
    if (a !== b) { sets[a].add(b); sets[b].add(a); }
    if (b !== c) { sets[b].add(c); sets[c].add(b); }
    if (a !== c) { sets[a].add(c); sets[c].add(a); }
  }
  const offsets = new Uint32Array(nGroups + 1);
  for (let i = 0; i < nGroups; i++) offsets[i + 1] = offsets[i] + sets[i].size;
  const nbrs = new Uint32Array(offsets[nGroups]);
  for (let i = 0; i < nGroups; i++) nbrs.set([...sets[i]], offsets[i]);
  return { offsets, nbrs };
}

function segDist(p, a, ab, abLen2, out) {
  let t = abLen2 > 0 ? ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / abLen2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.set(a.x + ab.x * t, a.y + ab.y * t, a.z + ab.z * t);
  return out.distanceTo(p);
}

/**
 * 计算每个顶点的骨骼权重（最多 4 根）：
 *  距骨段距离的反四次方 → 可见性校正（被网格挡住的骨骼大幅降权，防止手臂吸走躯干）
 *  → 网格拉普拉斯平滑 → 取前 4 归一化。
 */
export async function computeSkinWeights(asset, joints, bvh, { smoothIters = 6, visibility = true, onProgress } = {}) {
  const H = asset.height;
  const B = joints.length;
  const index = new Map(joints.map((j, i) => [j.name, i]));
  const segs = [];
  for (let i = 0; i < B; i++) {
    const j = joints[i];
    if (isEndJoint(j.name)) continue;
    const kids = joints.filter((c) => c.parent === j.name);
    const targets = kids.map((c) => c.pos);
    if (!kids.length) {
      // 叶子关节（非 End 标记）：沿父→自身方向延伸一小段
      const p = j.parent ? joints[index.get(j.parent)].pos : null;
      const d = p ? new THREE.Vector3().subVectors(j.pos, p) : new THREE.Vector3(0, 0.05 * H, 0);
      targets.push(j.pos.clone().addScaledVector(d, 0.6));
    }
    for (const t of targets) {
      const ab = new THREE.Vector3().subVectors(t, j.pos);
      segs.push({ bone: i, a: j.pos.clone(), ab, len2: ab.lengthSq() });
    }
  }
  if (!segs.length) throw new Error('没有可用的骨段');

  const totalVerts = asset.parts.reduce((s, p) => s + p.geometry.attributes.position.count, 0);
  let processed = 0;
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const q = new THREE.Vector3();
  const closest = Array.from({ length: B }, () => new THREE.Vector3());
  const dist = new Float64Array(B);
  const eps = 1e-3 * H;

  for (const part of asset.parts) {
    const geo = part.geometry;
    const pos = geo.attributes.position;
    const normal = geo.attributes.normal;
    const { groupOf, reps } = weldVertices(pos, 1e-5 * H);
    const G = reps.length;
    const W = new Float32Array(G * B);
    const cand = [];

    for (let g = 0; g < G; g++) {
      const vi = reps[g];
      p.fromBufferAttribute(pos, vi);
      if (normal) nrm.fromBufferAttribute(normal, vi); else nrm.set(0, 0, 0);
      dist.fill(Infinity);
      for (const s of segs) {
        const d = segDist(p, s.a, s.ab, s.len2, q);
        if (d < dist[s.bone]) { dist[s.bone] = d; closest[s.bone].copy(q); }
      }
      let dmin = Infinity;
      for (let b = 0; b < B; b++) if (dist[b] < dmin) dmin = dist[b];
      cand.length = 0;
      for (let b = 0; b < B; b++) if (dist[b] <= dmin * 2.2 + 0.015 * H) cand.push(b);
      cand.sort((a, b) => dist[a] - dist[b]);
      if (cand.length > 6) cand.length = 6;

      const vis = cand.map(() => 1);
      if (visibility && cand.length > 1) {
        let anyVisible = false;
        for (let k = 0; k < cand.length; k++) {
          const b = cand[k];
          const target = closest[b];
          _ray.origin.copy(p).addScaledVector(nrm, -eps);
          _ray.direction.subVectors(target, _ray.origin);
          const len = _ray.direction.length();
          if (len < eps * 2) { anyVisible = true; continue; }
          _ray.direction.divideScalar(len);
          const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, len);
          if (hit && hit.distance < len - eps) vis[k] = 0.04;
          else anyVisible = true;
        }
        if (!anyVisible) vis.fill(1);
      }
      let sum = 0;
      for (let k = 0; k < cand.length; k++) {
        const d = Math.max(dist[cand[k]], 1e-4 * H) / H;
        const w = vis[k] / (d * d * d * d);
        W[g * B + cand[k]] = w;
        sum += w;
      }
      for (let k = 0; k < cand.length; k++) W[g * B + cand[k]] /= sum;

      if ((++processed & 2047) === 0) {
        onProgress?.(0.85 * (processed / totalVerts));
        await new Promise((r) => setTimeout(r));
      }
    }
    processed += pos.count - G;

    // 拉普拉斯平滑
    if (smoothIters > 0) {
      const { offsets, nbrs } = buildAdjacency(geo, groupOf, G);
      let cur = W;
      let next = new Float32Array(G * B);
      for (let it = 0; it < smoothIters; it++) {
        for (let g = 0; g < G; g++) {
          const o0 = offsets[g];
          const o1 = offsets[g + 1];
          const n = o1 - o0;
          const base = g * B;
          if (!n) { for (let b = 0; b < B; b++) next[base + b] = cur[base + b]; continue; }
          for (let b = 0; b < B; b++) {
            let acc = 0;
            for (let o = o0; o < o1; o++) acc += cur[nbrs[o] * B + b];
            next[base + b] = 0.5 * cur[base + b] + (0.5 * acc) / n;
          }
        }
        [cur, next] = [next, cur];
        await new Promise((r) => setTimeout(r));
      }
      if (cur !== W) W.set(cur);
    }

    // 每个焊接组取前 4，再展开到真实顶点
    const gIdx = new Uint16Array(G * 4);
    const gW = new Float32Array(G * 4);
    const top = [0, 0, 0, 0];
    const topW = [0, 0, 0, 0];
    for (let g = 0; g < G; g++) {
      topW.fill(-1);
      const base = g * B;
      for (let b = 0; b < B; b++) {
        const w = W[base + b];
        if (w <= topW[3]) continue;
        let k = 3;
        while (k > 0 && w > topW[k - 1]) { topW[k] = topW[k - 1]; top[k] = top[k - 1]; k--; }
        topW[k] = w; top[k] = b;
      }
      let s = 0;
      for (let k = 0; k < 4; k++) { if (topW[k] < 0.01) topW[k] = 0; s += topW[k]; }
      for (let k = 0; k < 4; k++) topW[k] = s > 0 ? topW[k] / s : k === 0 ? 1 : 0;
      for (let k = 0; k < 4; k++) {
        gIdx[g * 4 + k] = topW[k] > 0 ? top[k] : 0;
        gW[g * 4 + k] = topW[k];
      }
    }
    const si = new Uint16Array(pos.count * 4);
    const sw = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const g = groupOf[i];
      for (let k = 0; k < 4; k++) {
        si[i * 4 + k] = gIdx[g * 4 + k];
        sw[i * 4 + k] = gW[g * 4 + k];
      }
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  }
  onProgress?.(1);
}

/** 用关节和已写入权重的几何体构建可动画的角色 */
export function buildRig(asset, joints) {
  const bones = joints.map((j) => {
    const b = new THREE.Bone();
    b.name = j.name;
    return b;
  });
  const index = new Map(joints.map((j, i) => [j.name, i]));
  let root = null;
  joints.forEach((j, i) => {
    const pi = j.parent ? index.get(j.parent) : undefined;
    if (pi !== undefined) {
      bones[pi].add(bones[i]);
      bones[i].position.subVectors(j.pos, joints[pi].pos);
    } else {
      root = bones[i];
      bones[i].position.copy(j.pos);
    }
  });
  const group = new THREE.Group();
  group.name = 'rigged_model';
  group.add(root);
  const meshes = asset.parts.map((p) => {
    const m = new THREE.SkinnedMesh(p.geometry, p.material);
    m.name = p.name;
    m.frustumCulled = false;
    group.add(m);
    return m;
  });
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  for (const m of meshes) m.bind(skeleton, new THREE.Matrix4());
  const rest = new Map(bones.map((b) => [b.name, b.position.clone()]));
  return { group, skeleton, bones, root, meshes, rest, boneMap: new Map(bones.map((b) => [b.name, b])), height: asset.height };
}

/** 权重热力图显示（null 关闭） */
const heatMat = new THREE.MeshBasicMaterial({ vertexColors: true });
export function setWeightView(rig, boneIndex) {
  for (const m of rig.meshes) {
    const g = m.geometry;
    if (boneIndex == null) {
      if (m.userData.origMaterial) m.material = m.userData.origMaterial;
      if (g.userData.origColor !== undefined) {
        if (g.userData.origColor) g.setAttribute('color', g.userData.origColor);
        else g.deleteAttribute('color');
        delete g.userData.origColor;
      }
      continue;
    }
    if (!m.userData.origMaterial) m.userData.origMaterial = m.material;
    if (g.userData.origColor === undefined) g.userData.origColor = g.attributes.color || null;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    const col = new Float32Array(si.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < si.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === boneIndex) w += sw.getComponent(i, k);
      c.setHSL((1 - w) * 0.66, 0.9, 0.3 + w * 0.25);
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    m.material = heatMat;
  }
}
