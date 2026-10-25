// 给 AI 看的正视图 / 侧视图：正交渲染 + 0–100 坐标网格（可叠加当前骨骼）
import * as THREE from 'three';

const SIZE = 1024;
const MARGIN = 56; // 网格标注留白
let renderer;

export function makeFrame(asset) {
  const c = asset.box.getCenter(new THREE.Vector3());
  const S = Math.max(asset.size.x, asset.size.y, asset.size.z) * 1.12;
  const g = (v, c0) => ((v - c0) / S) * 100 + 50;
  const w = (gv, c0) => ((gv - 50) / 100) * S + c0;
  return {
    S, c,
    toGrid: (p) => ({ x: g(p.x, c.x), y: g(p.y, c.y), z: g(p.z, c.z) }),
    fromGrid: (x, y, z) => new THREE.Vector3(w(x, c.x), w(y, c.y), w(z, c.z)),
  };
}

function render(group, frame, view) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  const inner = SIZE - MARGIN * 2;
  renderer.setSize(inner, inner, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  scene.add(key);
  scene.add(group);
  const { S, c } = frame;
  const cam = new THREE.OrthographicCamera(-S / 2, S / 2, S / 2, -S / 2, 0.001, S * 40);
  if (view === 'front') {
    cam.position.set(c.x, c.y, c.z + S * 10);
    key.position.set(c.x + S, c.y + S * 2, c.z + S * 3);
  } else {
    cam.position.set(c.x - S * 10, c.y, c.z);
    key.position.set(c.x - S * 3, c.y + S * 2, c.z + S);
  }
  cam.lookAt(c);
  renderer.render(scene, cam);
  scene.remove(group);
  return renderer.domElement;
}

function drawGrid(ctx, view) {
  const inner = SIZE - MARGIN * 2;
  const px = (gv) => MARGIN + (gv / 100) * inner;
  const py = (gv) => MARGIN + (1 - gv / 100) * inner;
  ctx.save();
  ctx.font = '600 15px -apple-system, Segoe UI, Arial';
  for (let v = 0; v <= 100; v += 5) {
    const major = v % 10 === 0;
    ctx.strokeStyle = major ? 'rgba(0,113,227,0.38)' : 'rgba(0,113,227,0.15)';
    ctx.lineWidth = major ? 1.2 : 1;
    ctx.beginPath(); ctx.moveTo(px(v), MARGIN); ctx.lineTo(px(v), SIZE - MARGIN); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(MARGIN, py(v)); ctx.lineTo(SIZE - MARGIN, py(v)); ctx.stroke();
    if (major) {
      ctx.fillStyle = '#0060c0';
      ctx.textAlign = 'center';
      ctx.fillText(String(v), px(v), SIZE - MARGIN + 22);
      ctx.fillText(String(v), px(v), MARGIN - 10);
      ctx.textAlign = 'right';
      ctx.fillText(String(v), MARGIN - 8, py(v) + 5);
      ctx.textAlign = 'left';
      ctx.fillText(String(v), SIZE - MARGIN + 8, py(v) + 5);
    }
  }
  ctx.fillStyle = '#1d1d1f';
  ctx.font = '600 17px -apple-system, Segoe UI, Arial';
  ctx.textAlign = 'left';
  const title = view === 'front'
    ? "FRONT VIEW — horizontal = x, vertical = y.  Character faces the viewer: character's LEFT is image RIGHT."
    : 'SIDE VIEW (from character\'s right) — horizontal = z, vertical = y.  Character\'s FRONT is image RIGHT.';
  ctx.fillText(title, MARGIN - 40, 22);
  ctx.restore();
}

function drawSkeleton(ctx, joints, frame, view) {
  const inner = SIZE - MARGIN * 2;
  const proj = (p) => {
    const g = frame.toGrid(p);
    const h = view === 'front' ? g.x : g.z;
    return [MARGIN + (h / 100) * inner, MARGIN + (1 - g.y / 100) * inner];
  };
  const byName = new Map(joints.map((j) => [j.name, j]));
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(201,52,0,0.85)';
  for (const j of joints) {
    const p = j.parent && byName.get(j.parent);
    if (!p) continue;
    const [x0, y0] = proj(p.pos);
    const [x1, y1] = proj(j.pos);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.font = '600 12px -apple-system, Segoe UI, Arial';
  for (const j of joints) {
    const [x, y] = proj(j.pos);
    ctx.fillStyle = '#d70015';
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(j.name, x + 7, y - 6);
  }
  ctx.restore();
}

/**
 * @returns {{front: string, side: string}} base64 PNG（不含 data: 前缀）
 */
export function snapshotViews(makeGroup, frame, joints = null) {
  const out = {};
  for (const view of ['front', 'side']) {
    const glCanvas = render(makeGroup(), frame, view);
    const cv = document.createElement('canvas');
    cv.width = SIZE; cv.height = SIZE;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(glCanvas, MARGIN, MARGIN);
    drawGrid(ctx, view);
    if (joints) drawSkeleton(ctx, joints, frame, view);
    out[view] = cv.toDataURL('image/png').split(',')[1];
  }
  return out;
}
