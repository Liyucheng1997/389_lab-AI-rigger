// 模型加载与规范化：把任意 GLB 的所有网格烘焙到世界坐标，
// 统一成「Y 向上、面朝 +Z、脚底 y=0、水平居中」，并合并成一组静态部件。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/libs/';

let loader;
function getLoader(renderer) {
  if (loader) return loader;
  loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(THREE_CDN + 'draco/gltf/');
  loader.setDRACOLoader(draco);
  const ktx2 = new KTX2Loader().setTranscoderPath(THREE_CDN + 'basis/');
  if (renderer) ktx2.detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** @returns {Promise<THREE.Object3D>} */
export async function loadGLB(source, renderer) {
  const l = getLoader(renderer);
  if (typeof source === 'string') return (await l.loadAsync(source)).scene;
  const buf = await source.arrayBuffer();
  return new Promise((resolve, reject) => l.parse(buf, '', (g) => resolve(g.scene), reject));
}

/**
 * 从场景中提取网格部件，烘焙变换并规范化。
 * @param {THREE.Object3D} scene 原始场景（不会被修改）
 * @param {THREE.Euler} orient 额外的朝向修正
 */
export function extractParts(scene, orient = new THREE.Euler()) {
  scene.updateMatrixWorld(true);
  const orientM = new THREE.Matrix4().makeRotationFromEuler(orient);
  const parts = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    if (o.isInstancedMesh) return;
    const g = o.geometry.clone();
    if (o.isSkinnedMesh) {
      // 已带骨骼的模型：按当前姿势烘焙出可见的形状，再丢弃原骨骼
      o.skeleton.update();
      const pos = g.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        o.applyBoneTransform(i, v.fromBufferAttribute(pos, i));
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      g.deleteAttribute('normal');
    }
    for (const name of ['skinIndex', 'skinWeight', 'skinIndex1', 'skinWeight1']) g.deleteAttribute(name);
    g.morphAttributes = {};
    const m = new THREE.Matrix4().multiplyMatrices(orientM, o.matrixWorld);
    g.applyMatrix4(m);
    if (!g.attributes.normal) g.computeVertexNormals();
    // 镜像变换（行列式为负）会翻转三角形绕序
    if (m.determinant() < 0 && g.index) {
      const idx = g.index.array;
      for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    }
    parts.push({ name: o.name || `mesh${parts.length}`, geometry: g, material: o.material });
  });
  if (!parts.length) throw new Error('GLB 中没有找到网格');

  const box = new THREE.Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    box.union(p.geometry.boundingBox);
  }
  const center = box.getCenter(new THREE.Vector3());
  const shift = new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z);
  for (const p of parts) {
    p.geometry.applyMatrix4(shift);
    p.geometry.computeBoundingBox();
    p.geometry.computeBoundingSphere();
  }
  box.applyMatrix4(shift);
  const size = box.getSize(new THREE.Vector3());
  let vertexCount = 0;
  let triCount = 0;
  for (const p of parts) {
    vertexCount += p.geometry.attributes.position.count;
    triCount += (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count) / 3;
  }
  return { parts, box, size, height: size.y, vertexCount, triCount: Math.round(triCount) };
}

export function makeStaticGroup(asset) {
  const group = new THREE.Group();
  group.name = 'model';
  for (const p of asset.parts) {
    const mesh = new THREE.Mesh(p.geometry, p.material);
    mesh.name = p.name;
    group.add(mesh);
  }
  return group;
}

/** 生成一个 T-pose 的无骨骼人偶，方便没有素材时测试 */
export function makeDemoMannequin() {
  const geos = [];
  const add = (g, x, y, z, rx = 0, rz = 0) => {
    g.rotateX(rx);
    g.rotateZ(rz);
    g.translate(x, y, z);
    geos.push(g.toNonIndexed());
  };
  const cap = (r, len) => new THREE.CapsuleGeometry(r, len, 6, 14);
  // 躯干、骨盆、头
  add(cap(0.16, 0.36), 0, 1.22, 0);
  add(new THREE.SphereGeometry(0.17, 20, 14).scale(1.05, 0.75, 0.8), 0, 0.98, 0);
  add(cap(0.055, 0.08), 0, 1.53, 0);
  add(new THREE.SphereGeometry(0.115, 24, 18).scale(0.9, 1.1, 1), 0, 1.69, 0.01);
  add(new THREE.ConeGeometry(0.025, 0.05, 10), 0, 1.68, 0.12, Math.PI / 2); // 鼻子，标识正面
  for (const s of [1, -1]) {
    // 手臂（T-pose，沿 X 方向）
    add(cap(0.055, 0.26), s * 0.36, 1.42, 0, 0, Math.PI / 2);
    add(cap(0.045, 0.24), s * 0.64, 1.42, 0, 0, Math.PI / 2);
    add(new THREE.SphereGeometry(0.055, 12, 10).scale(1.3, 0.6, 1), s * 0.85, 1.42, 0);
    // 腿
    add(cap(0.075, 0.36), s * 0.1, 0.72, 0);
    add(cap(0.06, 0.36), s * 0.1, 0.3, 0);
    add(new THREE.BoxGeometry(0.1, 0.07, 0.24, 2, 1, 4), s * 0.1, 0.035, 0.05);
  }
  for (const g of geos) for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const merged = mergeGeometries(geos);
  merged.computeVertexNormals();
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.6 })));
  return scene;
}
