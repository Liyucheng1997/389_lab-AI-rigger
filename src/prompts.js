// 发给 Claude 的提示词：自动布骨（看图定关节）与动作编排（写动画 JSON）
import * as THREE from 'three';
import { isEndJoint } from './rig.js';

const HUMANOID_NAMES = `hips, spine, chest, neck, head, headEnd,
leftShoulder, leftUpperArm, leftLowerArm, leftHand, leftHandEnd,
rightShoulder, rightUpperArm, rightLowerArm, rightHand, rightHandEnd,
leftUpperLeg, leftLowerLeg, leftFoot, leftToes, leftToesEnd,
rightUpperLeg, rightLowerLeg, rightFoot, rightToes, rightToesEnd`;

export const RIG_SYSTEM = `You are an expert technical artist who builds animation skeletons for unrigged 3D models. You read orthographic reference renders that carry a coordinate grid and place each joint precisely at the anatomical pivot inside the body volume. You are careful about left/right: "left" always means the character's own left side.`;

const RIG_GUIDE = `
Coordinate conventions:
- Both images share one 0–100 grid with equal scale on both axes; y is the same in both images.
- FRONT view: horizontal = x, vertical = y. The model faces the viewer, so the character's LEFT side is on the image RIGHT (larger x).
- SIDE view (seen from the character's right side): horizontal = z, vertical = y. The character's FRONT is toward the image right (larger z).

Read each joint's x and y from the FRONT view and its z from the SIDE view.

Skeleton guidelines:
- Joints are pivot points placed INSIDE the volume, at the center of the limb's cross-section — never on the surface.
- Humanoid (incl. stylized/cartoon characters, robots with human layout): use exactly these names when the part exists:
  ${HUMANOID_NAMES}
  hips = pelvis center, a little above the hip joints. spine = lower back/waist. chest = rib cage center. neck = neck base. head = top of neck / skull base (pivot of the head). headEnd = top of the head.
  leftShoulder = inner clavicle end near the neck base. leftUpperArm = shoulder ball joint. leftLowerArm = elbow. leftHand = wrist. leftHandEnd = finger tips.
  leftUpperLeg = hip joint (top of the thigh). leftLowerLeg = knee. leftFoot = ankle. leftToes = ball of the foot. leftToesEnd = toe tip.
  Add extra chains only when clearly present and worth animating: tail1..N + tailEnd, ears, long hair/ponytail, skirt panels, wings, jaw. Do not add fingers unless hands are large and fingers clearly separated.
- Quadrupeds, creatures, vehicles or other shapes: design a sensible hierarchy rooted at the pelvis/center of mass. camelCase names; paired parts prefixed with left/right (left = character's left = larger x). Chains are numbered (spine1, spine2, neck1, tail1 …). Quadruped legs e.g. frontLeftUpperLeg, frontLeftLowerLeg, frontLeftFoot, frontLeftFootEnd.
- Every chain tip ends in a marker joint whose name ends with "End" (headEnd, tailEnd …). End markers get no skin weights.
- Exactly one root joint (parent null), normally hips/pelvis. Parents must appear before children.
- Integers or one decimal are precise enough. Mirror-symmetric models should get mirror-symmetric joints (x mirrored around the body's center line).

"facing" reports where the character's face/front points as seen in the FRONT view: "front" (toward the viewer — expected), "back", "left" (toward image left), "right", "up" or "down" (lying down).

Reply with one short sentence identifying the model, then exactly one fenced json block:
\`\`\`json
{"category":"humanoid","facing":"front","description":"...","joints":[{"name":"hips","parent":null,"x":50,"y":48,"z":50}]}
\`\`\``;

export function rigUserText(frame, asset, hint) {
  const a = frame.toGrid(asset.box.min);
  const b = frame.toGrid(asset.box.max);
  const f = (v) => v.toFixed(1);
  return `Image 1 is the FRONT view, image 2 is the SIDE view of the same unrigged model.
Model bounding box in grid units: x ${f(a.x)}–${f(b.x)}, y ${f(a.y)}–${f(b.y)}, z ${f(a.z)}–${f(b.z)}.
${hint ? `User's note about the model: ${hint}\n` : ''}${RIG_GUIDE}`;
}

export function rigRefineText(frame, asset, joints, hint) {
  const list = joints.map((j) => {
    const g = frame.toGrid(j.pos);
    return { name: j.name, parent: j.parent, x: +g.x.toFixed(1), y: +g.y.toFixed(1), z: +g.z.toFixed(1) };
  });
  return `${rigUserText(frame, asset, hint)}

The current skeleton is drawn on both images in red (dots = joints, lines = bones). Its joints in grid units:
${JSON.stringify(list)}

Check every joint against the renders: is it at the correct anatomical pivot, inside the volume, on the correct side? Fix positions that are off, and fix the hierarchy if something is missing or wrong. Return the COMPLETE corrected skeleton in the same JSON format.`;
}

// ---------- 动作编排 ----------
const AXIS_WORDS = [
  [new THREE.Vector3(1, 0, 0), 'left'], [new THREE.Vector3(-1, 0, 0), 'right'],
  [new THREE.Vector3(0, 1, 0), 'up'], [new THREE.Vector3(0, -1, 0), 'down'],
  [new THREE.Vector3(0, 0, 1), 'forward'], [new THREE.Vector3(0, 0, -1), 'back'],
];
function dirWord(v) {
  const n = v.clone().normalize();
  const parts = AXIS_WORDS.map(([a, w]) => [n.dot(a), w]).filter(([d]) => d > 0.38).sort((a, b) => b[0] - a[0]);
  return parts.map(([, w]) => w).join('-') || 'none';
}

/** 骨骼表 + 每根骨骼绕 X/Y/Z 正向旋转时的效果（自动计算，让 AI 不用自己推右手定则） */
export function describeRig(joints, height) {
  const byName = new Map(joints.map((j) => [j.name, j]));
  const rows = [];
  const axes = [['X', new THREE.Vector3(1, 0, 0)], ['Y', new THREE.Vector3(0, 1, 0)], ['Z', new THREE.Vector3(0, 0, 1)]];
  for (const j of joints) {
    if (isEndJoint(j.name)) continue;
    const kids = joints.filter((c) => c.parent === j.name);
    const dir = new THREE.Vector3();
    let note = '';
    if (kids.length === 1) dir.subVectors(kids[0].pos, j.pos);
    else if (kids.length > 1) {
      // 分叉关节：以「沿主链继续」的那个子关节为参照（髋→脊柱、胸→脖子）
      const ref = j.parent ? new THREE.Vector3().subVectors(j.pos, byName.get(j.parent).pos).normalize() : new THREE.Vector3(0, 1, 0);
      let best = kids[0];
      let bestDot = -Infinity;
      for (const k of kids) {
        const d = new THREE.Vector3().subVectors(k.pos, j.pos).normalize().dot(ref);
        if (d > bestDot) { bestDot = d; best = k; }
      }
      dir.subVectors(best.pos, j.pos);
      note = ` (branch: moves ${kids.map((k) => k.name).join(', ')}; effects given for ${best.name})`;
    } else if (j.parent) dir.subVectors(j.pos, byName.get(j.parent).pos);
    const p = j.pos.clone().divideScalar(height);
    const pos = `[${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}]`;
    if (dir.lengthSq() < 1e-12) {
      rows.push(`${j.name} | parent ${j.parent ?? '—'} | at ${pos} | point joint`);
      continue;
    }
    dir.normalize();
    const eff = axes.map(([name, ax]) => {
      if (Math.abs(dir.dot(ax)) > 0.85) {
        // 扭转：说明绕该轴转时「正面/顶部」转向哪边
        const refV = Math.abs(ax.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
        const r = refV.clone().applyAxisAngle(ax, THREE.MathUtils.degToRad(35)).sub(refV);
        return `+${name}: twist (${refV.z ? 'front' : 'top'} turns ${dirWord(r)})`;
      }
      const r = dir.clone().applyAxisAngle(ax, THREE.MathUtils.degToRad(35));
      return `+${name}: swings ${dirWord(r.sub(dir))}`;
    });
    rows.push(`${j.name} | parent ${j.parent ?? '—'} | at ${pos} | points ${dirWord(dir)}${note} | ${eff.join(', ')}`);
  }
  return rows.join('\n');
}

export function animSystem(joints, height) {
  const root = joints.find((j) => !j.parent)?.name;
  return `You are a senior character animator and choreographer working inside a web tool. You animate a rigged 3D character by writing an animation spec in JSON; the tool compiles it to keyframes and plays it immediately.

## Coordinate system
- +Y is up, +Z is the character's front (the way it faces), +X is the character's LEFT.
- Every bone's rest rotation is identity, so in the rest pose each bone's local axes equal those world axes. Rotations are local to the parent: rotating a parent carries all its children.
- Rotations are Euler angles in DEGREES, order XYZ, offsets from the rest pose. The rig table tells you exactly what a POSITIVE rotation about each axis does to each bone ("swings down" = the bone's far end moves down); use a negative angle for the opposite. When a parent is already rotated, axes rotate with it.
- Root ("${root}") position offsets are in units of CHARACTER HEIGHT relative to rest (0.1 = 10% of height): +Y up, +Z forward, +X character's left. There is no IK and no ground solver, so lower the root yourself when the knees bend, and raise it for jumps.

## Rig (rest pose = the bind pose of the model; "at" = joint position in heights)
name | parent | at [x,y,z] | rest direction | effect of +X, +Y, +Z rotation
${describeRig(joints, height)}

## Animation spec
{
  "name": "snake_case_name",
  "duration": seconds,
  "loop": true,                   // false for one-shot actions
  "bpm": 120,                     // optional, for dances
  "interpolation": "smooth",      // "smooth" (cubic) or "linear"
  "keyframes": [
    {"t": 0, "pose": {"boneName": [x, y, z], ...}, "root": [x, y, z], "ease": "linear"}   // root and ease optional
  ],
  "layers": [                     // optional additive oscillations on top of keyframes
    {"bone": "hips", "axis": "y", "amp": 8, "period": 1.0, "phase": 0, "from": 0, "to": 8, "fade": 0.5, "wave": "sine"},
    {"channel": "position", "axis": "y", "amp": 0.02, "beats": 1, "wave": "bounce"}   // root bob; amp in heights; "beats" uses bpm
  ]
}
Semantics: each bone is interpolated only between the keyframes that mention it, and holds its first/last value outside that range (for loop:true it wraps from its last key back to its first). Bones never mentioned stay in rest pose. "wave": "sine" | "bounce" (|sin|, always ≥0, good for bobbing) | "triangle"; "phase" is in cycles (0–1); "fade" ramps the layer in/out over that many seconds.

## How to animate well
- The rest pose may be a T-pose or A-pose: check the arms' rest direction in the table. For anything natural you must explicitly pose the arms (e.g. lowered to the sides) for the whole clip.
- Respect anatomy: knees and elbows only bend one way (check the table for which sign), avoid limbs passing through the body, keep feet planted unless stepping or jumping (when the hips go down, bend knees and pull the feet back up with the ankles).
- Use animation principles: anticipation before big moves, overshoot and settle, follow-through on head/arms/tail, arcs, offset timing between body parts instead of everything hitting the same frame.
- Loops must loop seamlessly: the pose at t=duration should match t=0.
- Dances: choose a bpm, put keyframes on beats and half-beats, structure in sections (intro, several distinct moves/phrases, a highlight, ending pose), and add groove with layers (hip sway, root bounce per beat, head bob, shoulder shimmy). Long dances (30s+) are fine — stay compact.
- Keep the JSON compact: integers for degrees, 3 decimals max for root offsets, no comments inside the JSON.
- When the user asks for a change, return the COMPLETE updated spec (not a diff) and keep the same "name". Use a new name only when the user wants a separate new animation.

## Reply format
Reply in the user's language. First 1–3 short sentences on what you made or changed (for dances, outline the sections and timing). Then exactly one \`\`\`json fenced block containing the full spec. If the user only asks a question that needs no animation change, answer without JSON.`;
}

export function animUserText(userText, currentSpec) {
  const cur = currentSpec
    ? `Current animation (the one the user is looking at):\n\`\`\`json\n${JSON.stringify(currentSpec)}\n\`\`\`\n\n`
    : 'There is no animation yet.\n\n';
  return `${cur}User request: ${userText}`;
}
