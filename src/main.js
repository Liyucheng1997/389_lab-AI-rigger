import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Viewer } from './viewer.js';
import { loadGLB, extractParts, makeStaticGroup, makeDemoMannequin } from './model.js';
import {
  humanoidTemplate, buildBVH, refineJoints, symmetrize, normalizeJoints,
  computeSkinWeights, buildRig, setWeightView, isEndJoint, sanitizeName,
} from './rig.js';
import { makeFrame, snapshotViews } from './snapshot.js';
import { RIG_SYSTEM, rigUserText, rigRefineText, animSystem, animUserText } from './prompts.js';
import { normalizeSpec, buildClip, specStats, PRESETS } from './anim.js';
import {
  settings, loadSettings, saveSettings, detectLocal, isLocalAvailable, callClaude,
  extractJson, stripJson, MODELS,
} from './ai.js';

const $ = (id) => document.getElementById(id);
const viewer = new Viewer($('viewport'));

const state = {
  source: null,
  sourceName: '',
  orient: new THREE.Quaternion(),
  asset: null,
  staticGroup: null,
  bvh: null,
  joints: [],
  selected: null,
  editing: false,
  rig: null,
  rigJoints: null, // 绑定时的关节快照
  rigDirty: false,
  clips: [], // { name, versions: [spec], clip, action }
  current: -1,
  chat: [], // { role, text }
  busy: false,
  abort: null,
};

// ---------- 通用 UI ----------
function toast(text, type = 'info', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = text;
  $('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

function setBusy(text) {
  state.busy = !!text;
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
  refreshButtons();
}

function refreshButtons() {
  const hasAsset = !!state.asset;
  const hasJoints = state.joints.length > 0;
  const busy = state.busy;
  for (const id of ['btnAiRig', 'btnTemplate']) $(id).disabled = !hasAsset || busy;
  for (const id of ['btnAiRefine', 'btnSnap', 'btnSym', 'btnEdit', 'btnBind', 'btnExportRig']) $(id).disabled = !hasJoints || busy;
  $('btnImportRig').disabled = !hasAsset || busy;
  const ready = !!state.rig && !state.rigDirty;
  for (const id of ['btnExportGlb', 'btnImportAnim']) $(id).disabled = !ready || busy;
  $('btnExportAnim').disabled = state.current < 0;
  $('btnPlay').disabled = !ready || state.current < 0;
  $('btnBind').textContent = state.rig && !state.rigDirty ? '重新计算权重' : '计算权重并绑定';
  $('btnEdit').classList.toggle('active', state.editing);
  $('btnSend').textContent = state.abort ? '停止' : '发送';
  $('btnSend').disabled = busy && !state.abort;
  const step = !hasAsset ? 1 : !hasJoints ? 2 : !ready ? 3 : 4;
  document.querySelectorAll('.step').forEach((s) => {
    const n = Number(s.dataset.step);
    s.classList.toggle('current', n === step);
    s.classList.toggle('done', n < step);
  });
  $('stageTip').hidden = hasAsset;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const baseName = () => (state.sourceName || 'model').replace(/\.[^.]+$/, '');

// ---------- 模型 ----------
async function loadSource(scene, name) {
  state.source = scene;
  state.sourceName = name;
  state.orient.identity();
  rebuildAsset();
  toast(`已加载 ${name}`, 'success');
}

function rebuildAsset() {
  const euler = new THREE.Euler().setFromQuaternion(state.orient);
  state.asset = extractParts(state.source, euler);
  state.staticGroup = makeStaticGroup(state.asset);
  state.bvh = buildBVH(state.asset);
  state.joints = [];
  state.selected = null;
  disposeRig();
  viewer.setModel(state.staticGroup, state.asset.height);
  viewer.frame(state.asset);
  const a = state.asset;
  const s = a.size;
  $('modelMeta').innerHTML = `${escapeHtml(state.sourceName)}<br>${a.parts.length} 个网格 · ${a.vertexCount.toLocaleString()} 顶点 · ${a.triCount.toLocaleString()} 三角面<br>尺寸 ${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)}`;
  updateJointsUI();
}

function disposeRig() {
  if (state.rig) {
    viewer.mixer?.stopAllAction();
    setWeightView(state.rig, null);
  }
  state.rig = null;
  state.rigJoints = null;
  state.rigDirty = false;
  viewer.setRig(null);
  for (const c of state.clips) { c.clip = null; c.action = null; }
  $('chkWeights').checked = false;
  $('chkBones').checked = false;
}

function rotateModel(axis) {
  if (!state.source) return;
  if (axis === 'reset') state.orient.identity();
  else {
    const v = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis];
    state.orient.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...v), Math.PI / 2));
  }
  rebuildAsset();
}

// ---------- 关节 ----------
function setJoints(list, { refine = true } = {}) {
  let joints = normalizeJoints(list);
  if (refine) joints = refineJoints(joints, state.asset, state.bvh);
  state.joints = joints;
  if (!joints.find((j) => j.name === state.selected)) state.selected = null;
  markRigDirty();
  updateJointsUI();
}

function markRigDirty() {
  if (state.rig && !state.rigDirty) {
    state.rigDirty = true;
    viewer.mixer?.stopAllAction();
    setWeightView(state.rig, null);
    $('chkWeights').checked = false;
    viewer.setModel(state.staticGroup);
    toast('骨骼已修改，重新绑定后生效', 'info');
  }
}

function updateJointsUI() {
  const showMarkers = !state.rig || state.rigDirty || state.editing;
  viewer.setJoints(state.joints, state.selected, showMarkers);
  const list = $('jointList');
  if (!state.joints.length) {
    list.innerHTML = '<div class="empty">还没有骨骼</div>';
  } else {
    const depth = new Map();
    for (const j of state.joints) depth.set(j.name, j.parent ? depth.get(j.parent) + 1 : 0);
    list.innerHTML = state.joints.map((j) =>
      `<div class="joint-item${j.name === state.selected ? ' sel' : ''}" data-j="${j.name}">` +
      `<span class="pad" style="width:${depth.get(j.name) * 10}px"></span>` +
      `<span class="${isEndJoint(j.name) ? 'end' : ''}">${j.name}</span></div>`).join('');
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
  $('jointTools').hidden = !(state.editing && state.selected);
  refreshButtons();
}

function selectJoint(name) {
  state.selected = name;
  updateJointsUI();
  if (state.rig && !state.rigDirty && $('chkWeights').checked) showWeights();
}

function showWeights() {
  if (!state.rig) return;
  const idx = state.rig.bones.findIndex((b) => b.name === state.selected);
  setWeightView(state.rig, $('chkWeights').checked ? Math.max(0, idx) : null);
}

function jointsToGrid(frame, joints) {
  return joints.map((j) => ({ name: j.name, parent: j.parent, ...frame.toGrid(j.pos) }));
}

const FACING_FIX = {
  back: [[0, 1, 0], Math.PI],
  left: [[0, 1, 0], Math.PI / 2],
  right: [[0, 1, 0], -Math.PI / 2],
  up: [[1, 0, 0], Math.PI / 2],
  down: [[1, 0, 0], -Math.PI / 2],
};

async function aiRig(refine = false, allowFix = true) {
  if (!state.asset || state.busy) return;
  const frame = makeFrame(state.asset);
  const hint = $('rigHint').value.trim();
  const imgs = snapshotViews(() => makeStaticGroup(state.asset), frame, refine ? state.joints : null);
  const text = refine ? rigRefineText(frame, state.asset, state.joints, hint) : rigUserText(frame, state.asset, hint);
  const img = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
  const label = refine ? 'Claude 正在检查骨骼' : 'Claude 正在看图布骨';
  setBusy(`${label}…`);
  try {
    const { text: reply, info } = await callClaude({
      system: RIG_SYSTEM,
      messages: [{ role: 'user', content: [img(imgs.front), img(imgs.side), { type: 'text', text }] }],
      onText: (_, full) => setBusy(`${label}… 已接收 ${full.length} 字`),
      onStatus: (p) => p === 'thinking' && setBusy(`${label}… 思考中`),
      maxTokens: 32000,
    });
    const json = extractJson(reply);
    if (!json?.joints?.length) throw new Error('没能从回复中解析出骨骼 JSON');
    const fix = FACING_FIX[json.facing];
    if (!refine && fix && allowFix) {
      toast(`模型朝向为“${json.facing}”，已自动转正并重新布骨`, 'info', 3500);
      state.orient.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...fix[0]), fix[1]));
      rebuildAsset();
      setBusy(null);
      return aiRig(false, false);
    }
    const list = json.joints
      .filter((j) => j && j.name && [j.x, j.y, j.z].every((v) => Number.isFinite(Number(v))))
      .map((j) => ({ name: j.name, parent: j.parent ?? null, pos: frame.fromGrid(Number(j.x), Number(j.y), Number(j.z)) }));
    setJoints(list);
    const desc = stripJson(reply).split('\n')[0].slice(0, 120);
    toast(`${refine ? '已校正' : '布骨完成'}：${state.joints.length} 个关节`, 'success', 3200);
    $('modelMeta').dataset.desc = desc;
    console.info('[rig]', info, desc);
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error', 5000);
  } finally {
    setBusy(null);
  }
}

// ---------- 蒙皮 ----------
async function bind() {
  if (!state.joints.length || state.busy) return;
  const prevCurrent = state.current;
  setBusy('计算蒙皮权重…');
  $('bindProgress').hidden = false;
  const bar = $('bindProgress').firstElementChild;
  try {
    if (state.rig) setWeightView(state.rig, null);
    const t0 = performance.now();
    await computeSkinWeights(state.asset, state.joints, state.bvh, {
      visibility: $('chkVis').checked,
      onProgress: (p) => { bar.style.width = `${(p * 100).toFixed(0)}%`; setBusy(`计算蒙皮权重… ${(p * 100).toFixed(0)}%`); },
    });
    disposeRig();
    state.rig = buildRig(state.asset, state.joints);
    state.rigJoints = state.joints.map((j) => ({ name: j.name, parent: j.parent, pos: j.pos.clone() }));
    viewer.setModel(state.rig.group);
    viewer.setRig(state.rig);
    viewer.skeletonHelper.visible = $('chkBones').checked;
    // 已有动画用新骨骼重新编译
    for (const c of state.clips) compileClip(c);
    state.current = Math.min(prevCurrent, state.clips.length - 1);
    if (state.current >= 0) playCurrent();
    updateJointsUI();
    updateClipUI();
    toast(`绑定完成（${((performance.now() - t0) / 1000).toFixed(1)}s），可以开始编排动作`, 'success');
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error', 5000);
  } finally {
    $('bindProgress').hidden = true;
    bar.style.width = '0';
    setBusy(null);
  }
}

// ---------- 动画 ----------
function compileClip(c) {
  const spec = c.versions[c.versions.length - 1];
  c.clip = buildClip(spec, state.rig);
  c.action = viewer.mixer.clipAction(c.clip);
  c.action.setLoop(spec.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  c.action.clampWhenFinished = true;
}

function addSpec(raw) {
  const { spec, warnings } = normalizeSpec(raw, state.rig);
  let i = state.clips.findIndex((c) => c.name === spec.name);
  if (i < 0) {
    state.clips.push({ name: spec.name, versions: [spec] });
    i = state.clips.length - 1;
  } else {
    state.clips[i].versions.push(spec);
  }
  const c = state.clips[i];
  if (c.action) { c.action.stop(); viewer.mixer.uncacheAction(c.clip); }
  compileClip(c);
  state.current = i;
  playCurrent();
  updateClipUI();
  return { spec, warnings };
}

function currentClip() {
  return state.clips[state.current] || null;
}

function playCurrent() {
  if (!viewer.mixer) return;
  viewer.mixer.stopAllAction();
  state.rig.skeleton.pose();
  const c = currentClip();
  if (!c?.action) return;
  c.action.reset().play();
  c.action.timeScale = Number($('speedSelect').value);
  setPlayIcon(true);
}

function setPlayIcon(playing) {
  $('icoPlay').hidden = playing;
  $('icoPause').hidden = !playing;
}

function togglePlay() {
  const c = currentClip();
  if (!c?.action) return;
  if (!c.action.isRunning() && !c.action.paused) {
    c.action.reset().play();
    setPlayIcon(true);
    return;
  }
  c.action.paused = !c.action.paused;
  if (!c.action.paused && c.action.time >= c.clip.duration - 1e-3 && c.action.loop === THREE.LoopOnce) c.action.reset();
  setPlayIcon(!c.action.paused);
}

function updateClipUI() {
  const sel = $('clipSelect');
  sel.innerHTML = state.clips.length
    ? state.clips.map((c, i) => `<option value="${i}">${escapeHtml(c.name)}${c.versions.length > 1 ? ` · v${c.versions.length}` : ''}</option>`).join('')
    : '<option value="">无动画</option>';
  if (state.current >= 0) sel.value = String(state.current);
  refreshButtons();
}

viewer.onFrame = () => {
  const c = currentClip();
  if (!c?.action || state.scrubbing) return;
  const d = c.clip.duration;
  const t = c.action.time % (d || 1);
  $('scrub').value = String(Math.round((t / d) * 1000));
  $('timeLabel').textContent = `${t.toFixed(2)} / ${d.toFixed(2)}`;
  if (!c.action.isRunning() && !c.action.paused) setPlayIcon(false);
};

// ---------- 对话编排 ----------
function addMsg(role, html, cls = '') {
  const el = document.createElement('div');
  el.className = `msg ${role} ${cls}`.trim();
  el.innerHTML = html;
  $('chatLog').appendChild(el);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function liveText(full) {
  const fence = full.indexOf('```');
  if (fence < 0) return escapeHtml(full);
  const before = escapeHtml(full.slice(0, fence).trim());
  const size = full.length - fence;
  return `${before}\n<span class="typing">正在生成动画数据… ${size.toLocaleString()} 字符</span>`;
}

async function sendChat(text) {
  text = text.trim();
  if (!text) return;
  if (!state.rig || state.rigDirty) { toast('请先完成骨骼绑定', 'error'); return; }
  $('chatInput').value = '';
  addMsg('user', escapeHtml(text));
  const bubble = addMsg('ai', '<span class="typing">思考中…</span>');
  const cur = currentClip();
  const curSpec = cur ? cur.versions[cur.versions.length - 1] : null;
  const messages = [
    ...state.chat.map((m) => ({ role: m.role, content: m.text })),
    { role: 'user', content: animUserText(text, curSpec) },
  ];
  state.abort = new AbortController();
  refreshButtons();
  const started = performance.now();
  let gotText = false;
  const timer = setInterval(() => {
    if (!gotText) bubble.innerHTML = `<span class="typing">思考中… ${Math.round((performance.now() - started) / 1000)}s（长舞蹈可能需要几分钟）</span>`;
  }, 1000);
  try {
    const { text: reply, info } = await callClaude({
      system: animSystem(state.rigJoints, state.rig.height),
      messages,
      signal: state.abort.signal,
      onText: (_, full) => {
        gotText = true;
        bubble.innerHTML = liveText(full);
        $('chatLog').scrollTop = $('chatLog').scrollHeight;
      },
    });
    clearInterval(timer);
    const prose = stripJson(reply);
    const json = extractJson(reply);
    let html = escapeHtml(prose || '（已生成）');
    let note = prose;
    if (json && (json.keyframes || json.layers)) {
      const { spec, warnings } = addSpec(json);
      const c = currentClip();
      html += `<div class="clip-card"><b>${escapeHtml(spec.name)}</b><span class="muted">${specStats(spec)}${c.versions.length > 1 ? ` · 第 ${c.versions.length} 版` : ''}</span></div>`;
      if (warnings.length) html += `<span class="warn">${escapeHtml(warnings.join('；'))}</span>`;
      note = `${prose}\n[已生成动画「${spec.name}」，${specStats(spec)}]`;
    } else if (reply.includes('```')) {
      html += '<span class="warn">动画 JSON 解析失败，可以让我“重新输出完整 JSON”。</span>';
    }
    html += `<span class="info">${escapeHtml(info)}</span>`;
    bubble.innerHTML = html;
    state.chat.push({ role: 'user', text }, { role: 'assistant', text: note || '好的。' });
  } catch (e) {
    if (e.name === 'AbortError' || state.abort?.signal.aborted) {
      bubble.innerHTML = '<span class="typing">已停止</span>';
    } else {
      console.error(e);
      bubble.className = 'msg ai err';
      bubble.textContent = e.message || String(e);
    }
  } finally {
    clearInterval(timer);
    state.abort = null;
    refreshButtons();
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
  }
}

function applyPreset(key) {
  if (!state.rig || state.rigDirty) { toast('请先完成骨骼绑定', 'error'); return; }
  const { spec, warnings } = addSpec(structuredClone(PRESETS[key]));
  addMsg('ai', `已应用离线预设<div class="clip-card"><b>${spec.name}</b><span class="muted">${specStats(spec)}</span></div>${warnings.length ? `<span class="warn">${escapeHtml(warnings.join('；'))}</span>` : ''}`);
}

// ---------- 导出 ----------
async function exportGlb() {
  if (!state.rig) return;
  setWeightView(state.rig, null);
  $('chkWeights').checked = false;
  viewer.mixer.stopAllAction();
  state.rig.skeleton.pose();
  state.rig.group.updateMatrixWorld(true);
  const clips = state.clips.filter((c) => c.clip).map((c) => c.clip);
  try {
    const result = await new GLTFExporter().parseAsync(state.rig.group, { binary: true, animations: clips });
    download(new Blob([result], { type: 'model/gltf-binary' }), `${baseName()}_rigged.glb`);
    toast(`已导出：${state.rig.bones.length} 骨骼 · ${clips.length} 段动画`, 'success');
  } catch (e) {
    console.error(e);
    toast(`导出失败：${e.message}`, 'error', 5000);
  } finally {
    if (state.current >= 0) playCurrent();
  }
}

function exportAnimJson() {
  const specs = state.clips.map((c) => c.versions[c.versions.length - 1]);
  if (!specs.length) return;
  download(new Blob([JSON.stringify({ clips: specs }, null, 1)], { type: 'application/json' }), `${baseName()}_animations.json`);
}

function exportRigJson() {
  const data = {
    format: 'ai-rigger-skeleton/1',
    height: state.asset.height,
    orient: state.orient.toArray(),
    joints: state.joints.map((j) => ({ name: j.name, parent: j.parent, pos: j.pos.toArray().map((v) => +v.toFixed(5)) })),
  };
  download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${baseName()}_skeleton.json`);
}

let jsonMode = null;
async function onJsonFile(file) {
  const data = JSON.parse(await file.text());
  if (jsonMode === 'rig') {
    if (!Array.isArray(data.joints)) throw new Error('不是骨骼 JSON');
    if (data.orient) {
      state.orient.fromArray(data.orient);
      rebuildAsset();
    }
    const scale = data.height ? state.asset.height / data.height : 1;
    setJoints(data.joints.map((j) => ({ name: j.name, parent: j.parent, pos: new THREE.Vector3(...j.pos).multiplyScalar(scale) })), { refine: false });
    toast(`已导入 ${state.joints.length} 个关节`, 'success');
  } else {
    const specs = Array.isArray(data.clips) ? data.clips : [data];
    for (const s of specs) addSpec(s);
    toast(`已导入 ${specs.length} 段动画`, 'success');
  }
}

// ---------- 设置 ----------
function renderProviderBadge() {
  const model = MODELS.find((m) => m.id === settings.model)?.label.replace(/（.*）/, '') || settings.model;
  const badge = $('providerBadge');
  const local = settings.provider === 'local' && isLocalAvailable();
  const ok = local || !!settings.apiKey;
  badge.querySelector('.dot').className = `dot ${ok ? 'ok' : 'warn'}`;
  badge.querySelector('span').textContent = local ? `本地订阅 · ${model}` : settings.apiKey ? `API · ${model}` : '未配置 API Key';
}

function openSettings() {
  const local = isLocalAvailable();
  $('modelSelect').innerHTML = MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  $('modelSelect').value = settings.model;
  $('effortSelect').value = settings.effort;
  $('apiKey').value = settings.apiKey;
  $('rememberKey').checked = settings.rememberKey;
  $('testResult').textContent = '';
  const seg = $('providerSeg');
  seg.querySelector('[data-v="local"]').disabled = !local;
  const renderSeg = () => {
    const p = settings.provider === 'local' && local ? 'local' : 'api';
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === p));
    $('apiFields').hidden = p !== 'api';
    $('providerHint').textContent = p === 'local'
      ? '通过本机 server.mjs 调用已登录的 Claude Code，消耗你的订阅额度，不需要 API Key。仅在 npm start 启动的本地页面可用。'
      : local ? '浏览器直接调用 Anthropic API，按量计费。' : '当前页面不是由本地服务提供（或服务未启动），只能使用 API Key。部署到任意静态托管后也是这种模式。';
  };
  seg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    settings.provider = b.dataset.v;
    saveSettings();
    renderSeg();
    renderProviderBadge();
  };
  renderSeg();
  $('settingsModal').hidden = false;
}

function closeSettings() {
  settings.model = $('modelSelect').value;
  settings.effort = $('effortSelect').value;
  settings.apiKey = $('apiKey').value.trim();
  settings.rememberKey = $('rememberKey').checked;
  saveSettings();
  renderProviderBadge();
  $('settingsModal').hidden = true;
}

async function testConnection() {
  closeSettings();
  $('settingsModal').hidden = false;
  const out = $('testResult');
  out.innerHTML = '<i class="dot"></i>测试中…';
  try {
    const { text, info } = await callClaude({
      system: 'Reply with exactly: OK',
      messages: [{ role: 'user', content: 'ping' }],
      effort: 'low',
      maxTokens: 2000,
    });
    out.innerHTML = `<i class="dot ok"></i>${escapeHtml(text.trim().slice(0, 20))} · ${escapeHtml(info)}`;
  } catch (e) {
    out.innerHTML = `<i class="dot err"></i>${escapeHtml(e.message)}`;
  }
}

// ---------- 事件绑定 ----------
async function handleFile(file) {
  if (!file) return;
  if (!/\.(glb|gltf)$/i.test(file.name)) { toast('请选择 .glb 文件', 'error'); return; }
  setBusy(`读取 ${file.name}…`);
  try {
    await loadSource(await loadGLB(file, viewer.renderer), file.name);
  } catch (e) {
    console.error(e);
    toast(`加载失败：${e.message}`, 'error', 5000);
  } finally {
    setBusy(null);
  }
}

$('fileInput').onchange = (e) => handleFile(e.target.files[0]);
const drop = $('drop');
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  handleFile(e.dataTransfer.files[0]);
});
$('btnUrl').onclick = async () => {
  const url = $('urlInput').value.trim();
  if (!url) return;
  setBusy('下载模型…');
  try {
    await loadSource(await loadGLB(url, viewer.renderer), decodeURIComponent(url.split('/').pop().split('?')[0]) || 'model.glb');
  } catch (e) {
    toast(`加载失败：${e.message}`, 'error', 5000);
  } finally {
    setBusy(null);
  }
};
$('btnDemo').onclick = () => loadSource(makeDemoMannequin(), 'demo_mannequin.glb');
document.querySelectorAll('[data-rot]').forEach((b) => (b.onclick = () => rotateModel(b.dataset.rot)));

$('btnAiRig').onclick = () => aiRig(false);
$('btnAiRefine').onclick = () => aiRig(true);
$('btnTemplate').onclick = () => { setJoints(humanoidTemplate(state.asset)); toast('已套用人形模板，可拖动关节微调'); };
$('btnSnap').onclick = () => { setJoints(state.joints); toast('已吸附到网格中心'); };
$('btnSym').onclick = () => { setJoints(symmetrize(state.joints.map((j) => ({ ...j, pos: j.pos.clone() })), state.asset), { refine: false }); toast('已左右对称'); };
$('btnEdit').onclick = () => {
  state.editing = !state.editing;
  viewer.setEditing(state.editing);
  if (state.editing && !state.selected && state.joints.length) state.selected = state.joints[0].name;
  updateJointsUI();
};
$('jointList').onclick = (e) => {
  const it = e.target.closest('[data-j]');
  if (it) selectJoint(it.dataset.j);
};
viewer.onPick = (name) => { if (name || state.editing) selectJoint(name ?? state.selected); };
viewer.onJointMove = (pos) => {
  const j = state.joints.find((x) => x.name === state.selected);
  if (!j) return;
  j.pos.copy(pos);
  viewer.setJoints(state.joints, state.selected, true);
};
viewer.onJointDragEnd = () => { markRigDirty(); updateJointsUI(); };

$('btnAddJoint').onclick = () => {
  const p = state.joints.find((j) => j.name === state.selected);
  if (!p) return;
  const name = prompt('新关节名称（英文、驼峰，如 tail1；末端标记以 End 结尾）', `${p.name}Child`);
  if (!name) return;
  const used = new Set(state.joints.map((j) => j.name));
  const n = sanitizeName(name, used);
  state.joints.push({ name: n, parent: p.name, pos: p.pos.clone().add(new THREE.Vector3(0, 0.06 * state.asset.height, 0)) });
  state.selected = n;
  setJoints(state.joints, { refine: false });
};
$('btnRenameJoint').onclick = () => {
  const j = state.joints.find((x) => x.name === state.selected);
  if (!j) return;
  const name = prompt('重命名关节', j.name);
  if (!name || name === j.name) return;
  const n = sanitizeName(name, new Set(state.joints.map((x) => x.name)));
  for (const c of state.joints) if (c.parent === j.name) c.parent = n;
  j.name = n;
  state.selected = n;
  setJoints(state.joints, { refine: false });
};
$('btnDelJoint').onclick = () => {
  const j = state.joints.find((x) => x.name === state.selected);
  if (!j) return;
  const kids = state.joints.filter((c) => c.parent === j.name);
  if (!j.parent && kids.length !== 1) { toast('根关节只有一个子关节时才能删除', 'error'); return; }
  for (const c of kids) c.parent = j.parent;
  state.joints = state.joints.filter((x) => x !== j);
  state.selected = j.parent || kids[0]?.name || null;
  setJoints(state.joints, { refine: false });
};

$('btnBind').onclick = bind;
$('chkWeights').onchange = () => {
  if (!state.rig || state.rigDirty) { $('chkWeights').checked = false; return; }
  if (!state.selected) state.selected = state.rig.bones[0].name;
  updateJointsUI();
  showWeights();
};
$('chkBones').onchange = () => { if (viewer.skeletonHelper) viewer.skeletonHelper.visible = $('chkBones').checked; };

$('btnPlay').onclick = togglePlay;
$('clipSelect').onchange = () => { state.current = Number($('clipSelect').value); playCurrent(); refreshButtons(); };
$('speedSelect').onchange = () => { const c = currentClip(); if (c?.action) c.action.timeScale = Number($('speedSelect').value); };
$('scrub').addEventListener('input', () => {
  const c = currentClip();
  if (!c?.action) return;
  state.scrubbing = true;
  if (!c.action.isRunning()) c.action.play();
  c.action.paused = true;
  setPlayIcon(false);
  c.action.time = (Number($('scrub').value) / 1000) * c.clip.duration;
  viewer.mixer.update(0);
  $('timeLabel').textContent = `${c.action.time.toFixed(2)} / ${c.clip.duration.toFixed(2)}`;
});
$('scrub').addEventListener('change', () => { state.scrubbing = false; });
$('btnUndoClip').onclick = () => {
  const c = currentClip();
  if (!c || c.versions.length < 2) { toast('没有更早的版本'); return; }
  c.versions.pop();
  viewer.mixer.uncacheAction(c.clip);
  compileClip(c);
  playCurrent();
  updateClipUI();
  toast(`已回到第 ${c.versions.length} 版`);
};
$('btnDelClip').onclick = () => {
  const c = currentClip();
  if (!c) return;
  c.action?.stop();
  state.clips.splice(state.current, 1);
  state.current = state.clips.length - 1;
  if (state.current >= 0) playCurrent(); else state.rig?.skeleton.pose();
  updateClipUI();
};

$('btnSend').onclick = () => (state.abort ? state.abort.abort() : sendChat($('chatInput').value));
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.abort) sendChat($('chatInput').value);
  }
});
$('quick').onclick = (e) => {
  const b = e.target.closest('.chip');
  if (!b || state.abort) return;
  if (b.dataset.preset) applyPreset(b.dataset.preset);
  else sendChat(b.dataset.q);
};
$('btnNewChat').onclick = () => {
  state.chat = [];
  $('chatLog').querySelectorAll('.msg:not(.intro)').forEach((m) => m.remove());
  toast('已开始新对话（动画保留）');
};

$('btnExportGlb').onclick = exportGlb;
$('btnExportAnim').onclick = exportAnimJson;
$('btnExportRig').onclick = exportRigJson;
$('btnImportAnim').onclick = () => { jsonMode = 'anim'; $('jsonInput').click(); };
$('btnImportRig').onclick = () => { jsonMode = 'rig'; $('jsonInput').click(); };
$('jsonInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { await onJsonFile(f); } catch (err) { toast(`导入失败：${err.message}`, 'error', 5000); }
};

$('btnSettings').onclick = openSettings;
$('providerBadge').onclick = openSettings;
$('settingsModal').addEventListener('click', (e) => {
  if (e.target === $('settingsModal') || e.target.closest('[data-close]')) closeSettings();
});
$('btnTest').onclick = testConnection;
$('btnTheme').onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('rigger.theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  viewer.setTheme(dark);
};
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'Escape' && !$('settingsModal').hidden) closeSettings();
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
});

// ---------- 启动 ----------
loadSettings();
refreshButtons();
renderProviderBadge();
detectLocal().then((ok) => {
  if (!ok && settings.provider === 'local') settings.provider = 'api';
  renderProviderBadge();
});

// 调试/自动化入口
window.rigger = { state, viewer, aiRig, bind, sendChat, applyPreset, loadSource, makeDemoMannequin, setJoints, humanoidTemplate };
