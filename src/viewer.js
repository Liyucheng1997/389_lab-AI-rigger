// 3D 视口：模型显示、关节标记与拖拽编辑、骨架显示、动画播放
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.position.set(1.6, 1.4, 3.2);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.target.set(0, 0.9, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9aa2, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(-3, 3, -4);
    this.scene.add(rim);
    this.grid = new THREE.GridHelper(10, 20);
    this.scene.add(this.grid);

    this.jointGroup = new THREE.Group();
    this.jointGroup.renderOrder = 999;
    this.scene.add(this.jointGroup);
    this.jointMeshes = [];
    this.markerMat = new THREE.MeshBasicMaterial({ color: 0xff453a, depthTest: false, transparent: true });
    this.markerSelMat = new THREE.MeshBasicMaterial({ color: 0x0a84ff, depthTest: false, transparent: true });
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xff9f0a, depthTest: false, transparent: true, opacity: 0.9 });

    this.proxy = new THREE.Object3D();
    this.scene.add(this.proxy);
    this.tc = new TransformControls(this.camera, this.renderer.domElement);
    this.tc.setSize(0.8);
    this.tc.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (!e.value) this.onJointDragEnd?.();
    });
    this.tc.addEventListener('objectChange', () => this.onJointMove?.(this.proxy.position.clone()));
    this.scene.add(this.tc.getHelper());

    this.model = null;
    this.skeletonHelper = null;
    this.mixer = null;
    this.clock = new THREE.Clock();
    this.onFrame = null;

    this._down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { this._down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!this._down || this.tc.dragging) return;
      const moved = Math.hypot(e.clientX - this._down[0], e.clientY - this._down[1]);
      if (moved < 4) this._pick(e);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.setTheme(document.documentElement.dataset.theme === 'dark');
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  setTheme(dark) {
    this.scene.background = new THREE.Color(dark ? 0x111113 : 0xf0f0f3);
    const c = dark ? 0x3a3a3c : 0xd2d2d7;
    this.grid.material.color.set(c);
    this.grid.material.vertexColors = false;
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick() {
    const dt = this.clock.getDelta();
    if (this.mixer) this.mixer.update(dt);
    this.onFrame?.(dt);
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  }

  setModel(obj, height) {
    if (this.model) this.scene.remove(this.model);
    this.model = obj;
    if (obj) this.scene.add(obj);
    if (height) {
      this.height = height;
      const s = height / 1.8;
      this.grid.scale.setScalar(s);
      this.camera.near = height * 0.005;
      this.camera.far = height * 200;
      this.camera.updateProjectionMatrix();
    }
  }

  frame(asset) {
    const H = asset.height;
    const r = Math.max(asset.size.x, asset.size.y, asset.size.z);
    this.orbit.target.set(0, H * 0.5, 0);
    this.camera.position.set(r * 0.9, H * 0.7, r * 2.0);
    this.orbit.update();
  }

  setJoints(joints, selected, visible = true) {
    for (const m of this.jointMeshes) m.geometry?.dispose();
    this.jointGroup.clear();
    this.jointMeshes = [];
    if (!joints || !visible) { this.tc.detach(); return; }
    const H = this.height || 1.8;
    const sphere = new THREE.SphereGeometry(0.011 * H, 12, 8);
    const byName = new Map(joints.map((j) => [j.name, j]));
    const pts = [];
    for (const j of joints) {
      const m = new THREE.Mesh(sphere, j.name === selected ? this.markerSelMat : this.markerMat);
      m.position.copy(j.pos);
      m.renderOrder = 1000;
      m.userData.joint = j.name;
      this.jointGroup.add(m);
      this.jointMeshes.push(m);
      const p = j.parent && byName.get(j.parent);
      if (p) pts.push(p.pos, j.pos);
    }
    if (pts.length) {
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), this.lineMat);
      lines.renderOrder = 999;
      this.jointGroup.add(lines);
    }
    const sel = selected && byName.get(selected);
    if (sel && this.editing) {
      this.proxy.position.copy(sel.pos);
      this.tc.attach(this.proxy);
    } else {
      this.tc.detach();
    }
  }

  setEditing(on) {
    this.editing = on;
    if (!on) this.tc.detach();
  }

  _pick(e) {
    if (!this.jointMeshes.length) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // 关节球很小：按屏幕距离挑最近的
    let best = null;
    let bestD = 18;
    const v = new THREE.Vector3();
    for (const m of this.jointMeshes) {
      v.copy(m.position).project(this.camera);
      const sx = ((v.x + 1) / 2) * rect.width;
      const sy = ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(sx - (e.clientX - rect.left), sy - (e.clientY - rect.top));
      if (d < bestD && v.z < 1) { bestD = d; best = m; }
    }
    this.onPick?.(best ? best.userData.joint : null);
  }

  setRig(rig) {
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.dispose?.();
      this.skeletonHelper = null;
    }
    this.mixer = rig ? new THREE.AnimationMixer(rig.group) : null;
    if (rig) {
      this.skeletonHelper = new THREE.SkeletonHelper(rig.root);
      this.skeletonHelper.visible = false;
      this.scene.add(this.skeletonHelper);
    }
  }
}
