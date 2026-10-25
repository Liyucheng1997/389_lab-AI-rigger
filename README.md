# AI 骨骼绑定器

上传没有骨骼的 GLB，让 Claude 看图自动布骨、自动计算蒙皮权重，再用对话编排动作：从“挥手”到一整段多段落舞蹈都可以。结果能导出成带骨骼和动画的 GLB。

**在线版：https://liyucheng1997.github.io/389_lab-AI-rigger/**（打开后在“设置”里填你自己的 Anthropic API Key 即可使用，Key 只保存在你的浏览器里）

纯前端页面（three.js），AI 有两种通道：

| 通道 | 用途 | 计费 |
| --- | --- | --- |
| **本地订阅** | `npm start` 后在本机使用，经 `server.mjs` 调用你已登录的 Claude Code（`claude -p`） | 用你的 Claude 订阅额度 |
| **Anthropic API** | 在设置里填 API Key，浏览器直连 `api.anthropic.com`；部署成静态网站后就是这种模式 | 按 API 用量计费 |

## 快速开始（本地订阅测试）

前提：已安装 Node 18+，并且 `claude` 命令已登录（终端运行 `claude` 能正常对话）。

```bash
npm start
```

打开 http://localhost:5179 ，右上角显示“本地订阅 · Claude Opus 5.5”即连通。

1. **模型**：拖入 GLB（或点“使用演示人偶”）。要求 Y 向上、面朝 +Z；不对的话 AI 布骨时会自动识别朝向并转正，也可以手动点“绕 X/Y/Z 转 90°”。
2. **布骨**：点“AI 自动布骨”。Claude 会看带坐标网格的正视图和侧视图，给出关节位置；程序再用射线把每个关节吸附到肢体截面中心。可在备注里写“四足狐狸、有大尾巴”之类的提示。
   - “AI 校正”：把当前骨骼画到截图上让 Claude 检查修正。
   - “编辑关节”：在视口里点选关节并拖动坐标轴；可加子关节、重命名、删除。
   - “人形模板”：不用 AI 的兜底方案。
3. **蒙皮**：点“计算权重并绑定”。勾选“显示所选骨骼权重”可查看热力图。
4. **动作**：在右侧对话框描述动作，例如：
   - “自然地挥手打招呼”
   - “原地跳两次，有蓄力和落地缓冲”
   - “编一段 30 秒、128 BPM 的街舞，分 4 段，最后定格”
   - 之后可以继续说“第二段手臂再夸张一点”“整体慢一点”等，Claude 会在当前动画上修改；时间轴右侧的“↶”可回到上一版。
5. **导出**：“导出 GLB（骨骼+动画）”得到可直接用于 Blender / Unity / three.js 的文件；动画和骨骼也可以单独导出、导入为 JSON。

## 部署成网站（API Key 模式）

整个前端是静态文件：`index.html` + `src/`，依赖从 jsDelivr CDN 加载，不需要构建。上传到任意静态托管（GitHub Pages、Cloudflare Pages、Nginx……）即可。本仓库已通过 GitHub Pages 从 `main` 分支根目录发布，推送后自动更新：https://liyucheng1997.github.io/389_lab-AI-rigger/

访问者在“设置”里填自己的 Anthropic API Key。Key 默认只保存在当前标签页（sessionStorage），勾选“记住”才写入 localStorage；请求从浏览器直接发往 Anthropic（`dangerouslyAllowBrowser`），不经过你的服务器。因此不要在公开页面里预置你自己的 Key。

`server.mjs` 只在本机运行，只监听 127.0.0.1，并且 `/api` 请求必须带自定义请求头，其他网站无法借用你的订阅。

## 工作原理

- **布骨**（`src/snapshot.js`、`src/prompts.js`）：正交渲染正视图和侧视图，叠加 0–100 坐标网格，连同布骨规范一起发给 Claude（多模态）。Claude 返回关节名、父子关系和网格坐标，程序换算回 3D。
- **吸附**（`src/rig.js` → `refineJoints`）：用 three-mesh-bvh 沿 Z 轴射线求“体内区间”（按面法线计数，穿插的多层网格也能正确合并），把关节深度放到区间中点；再在垂直于骨骼的截面上放射 12 条射线，向截面中心收拢。
- **蒙皮**（`computeSkinWeights`）：顶点到各骨段距离的反四次方 → 可见性校正（被网格挡住的骨骼大幅降权，避免手臂吸走躯干的顶点）→ 在网格上做拉普拉斯平滑 → 每个顶点保留前 4 根骨骼。UV 接缝处的重复顶点会被焊接，权重保持一致。
- **动作**（`src/anim.js`）：所有骨骼的静止旋转都是单位旋转，Claude 只需输出“相对静止姿势的欧拉角（度）”。系统提示里会自动附上每根骨骼绕 X/Y/Z 正向旋转时“往哪边摆”的速查表，Claude 不用自己推右手定则。动画格式是关键帧 + 叠加的周期层（摆胯、踩拍弹跳等），程序以 30fps 烘焙成 three.js 的 AnimationClip。
- **模型**：默认 Claude Opus 5.5，可在设置里换 Sonnet 5.5（更快）或 Fable 5.1；思考强度默认 high。API 模式对系统提示开启了提示缓存，并启用 `fallbacks: "default"`（安全分类器误拒时由服务端换模型续答）。

## 已知限制

- 布骨精度取决于模型的轮廓是否清晰；手指默认不做（除非手很大且手指分开）。不满意可以用“AI 校正”或手动拖动关节。
- 没有 IK：Claude 需要自己通过降低根骨骼高度来保持脚着地，复杂动作可能出现轻微滑步。
- 自动权重是几何启发式算法，对宽松衣服、长裙等复杂结构不如专业软件，必要时导出后在 Blender 里微调权重。
- 本地订阅通道把多轮对话压平成一条消息发给 `claude -p`，只有最新一条消息带图片。

## 文件

```
index.html        页面结构 + importmap（three、three-mesh-bvh、@anthropic-ai/sdk）
server.mjs        本地静态服务 + Claude Code 桥接（SSE 流式）
src/main.js       界面与流程
src/ai.js         AI 通道（本地 / API）、设置存储、JSON 提取
src/prompts.js    布骨与动作编排提示词、骨骼速查表生成
src/model.js      GLB 加载与规范化、演示人偶
src/rig.js        关节吸附、对称、自动权重、构建 SkinnedMesh
src/anim.js       动画 JSON → AnimationClip、离线预设
src/snapshot.js   带网格的正交截图
src/viewer.js     3D 视口
src/tokens.css    设计变量；src/app.css 界面样式
```
