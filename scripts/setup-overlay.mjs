// scripts/setup-overlay.mjs
// 部署 Live2D overlay 运行时到 ~/.dsh/nico/rt/：
//   rt/live2d/   ← 素材（默认 ../live2d-deepseek-whale-girl/cubism，NICO_LIVE2D_SRC 可覆盖）
//   rt/overlay/  ← native/overlay/（model.html/bubble.html 等整目录，缺目录时跳过拷贝不报错）
//                  + pixi.min.js / cubism4.min.js / live2dcubismcore.min.js（CDN 拉取）
// Cubism Core 不随插件分发（Live2D 许可），与 sherpa-onnx 同为 setup 期拉取。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NICO_DIR } from '../lib/paths.mjs'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
export const EXP_NAMES = ['f01_normal','f02_smile','f03_angry','f04_sad',
                          'f05_surprised','f06_blush','f07_wink','f08_sleepy']

export function patchModel3(json) {
  const m = typeof json === 'string' ? JSON.parse(json) : structuredClone(json)
  // 素材 moc3 的 drawable 纹理索引 1-based（构建器写死），单张纹理声明会让索引 1
  // 越界 → Cubism 绑定不存在的纹理 → 黑剪影；双份声明让索引 1 有效。
  const tex = m.FileReferences.Textures
  if (Array.isArray(tex)) m.FileReferences.Textures = [...tex, ...tex]
  m.FileReferences.Expressions.forEach((e, i) => {
    // Name 以 exp 文件名为准（上游构建脚本把所有 Name 写成"普通"），
    // 无 File 时退回按文件序的 EXP_NAMES。
    e.Name = /([^/]+)\.exp3\.json$/.exec(e.File ?? '')?.[1] ?? EXP_NAMES[i] ?? e.Name
  })
  return m
}

// Cubism 物理设置里 Normalization 的规范形状（Cubism Editor 默认值）：
//   Position: {Minimum, Default, Maximum}  Angle: {Minimum, Default, Maximum}
// 素材库的 physics3.json 写成了 {Position:{X,Y}, Angle:0}（形状不对），pixi-live2d-display
// 读到的 min/max 都是 undefined → 归一化算出 NaN → 物理把 ParamHairFront/Back/Side、
// ParamFinSwing、ParamBowSwing 写成垃圾值 → 头发/鲸鱼耳/胸饰被甩成一团，与头身分家，
// 看起来就是「人物叠了多层、刘海看不见」。
const PHYSICS_NORMALIZATION = {
  Position: { Minimum: -1.0, Default: 0.0, Maximum: 1.0 },
  Angle: { Minimum: -30.0, Default: 0.0, Maximum: 30.0 },
}

const isNorm = (v) => v && typeof v === 'object' &&
  Number.isFinite(v.Minimum) && Number.isFinite(v.Default) && Number.isFinite(v.Maximum)

// 只在形状不对时改；已经是规范形状的原样保留（上游修好后本补丁自动变成空操作）。
export function patchPhysics(json) {
  const p = typeof json === 'string' ? JSON.parse(json) : structuredClone(json)
  for (const s of p.PhysicsSettings ?? []) {
    const n = s.Normalization
    if (!isNorm(n?.Position) || !isNorm(n?.Angle))
      s.Normalization = structuredClone(PHYSICS_NORMALIZATION)
  }
  // 素材把「参数单位→度」的系数误复用成「弧度→参数单位」的输出增益，
  // 比官方同类模型大约 4 倍；头稍动发丝就钳死在 ±1，像一层脱钩的残影。
  // 全组等比缩到最大 2（官方 Hiyori 为 1.5~2.1），保留各部件的相对幅度。
  const outputs = (p.PhysicsSettings ?? []).flatMap((s) => s.Output ?? [])
  const maxScale = Math.max(0, ...outputs.map((o) => Math.abs(o.Scale) || 0))
  if (maxScale > 2) {
    const ratio = 2 / maxScale
    for (const o of outputs) o.Scale *= ratio
  }
  return p
}

// pixi-live2d-display 0.4.0 会按 exp3.json 的 Blend 每帧应用表达式；素材全部
// 写成 Add，导致 ParamEyeStyle/ParamBrowStyle 等离散档位逐帧累加，切表情后旧
// 参数也清不掉（闭眼/怒眉/笑眼同时出现，像又叠了一张脸）。统一为 Overwrite，
// 并把所有表情涉及的面部参数补全到每个文件，保证切换时能复位。
// 头/身体角度属于 motion，不属于表情：剥离，避免表达式每帧把头部姿态钉死。
const EXPRESSION_DEFAULTS = { ParamEyeLOpen: 1, ParamEyeROpen: 1 }
const isMotionParam = (id) => /^Param(?:Body)?Angle[XYZ]$/.test(id)

export function patchExpressions(files) {
  const out = Object.fromEntries(Object.entries(files).map(([name, json]) => [
    name, typeof json === 'string' ? JSON.parse(json) : structuredClone(json),
  ]))
  const ids = new Set()
  for (const exp of Object.values(out)) {
    exp.Parameters = (exp.Parameters ?? []).filter((p) => !isMotionParam(p.Id))
    for (const p of exp.Parameters) ids.add(p.Id)
  }
  for (const exp of Object.values(out)) {
    // 离散变体不能交叉淡化：中间档位会让多种眼型/眉形同时半透明，仍像叠层。
    exp.FadeInTime = 0
    exp.FadeOutTime = 0
    const present = new Set(exp.Parameters.map((p) => p.Id))
    for (const id of ids) {
      if (!present.has(id))
        exp.Parameters.push({ Id: id, Value: EXPRESSION_DEFAULTS[id] ?? 0, Blend: 'Overwrite' })
    }
    for (const p of exp.Parameters) p.Blend = 'Overwrite'
  }
  return out
}

// 素材的手臂/手掌分层在旋转后会露出第二只「浮空手」。绑定源需要重画，
// 运行时先冻结 ParamArmL/R，保留静止时正确的接合；头身/头发/表情不受影响。
// 保留曲线和时间轴，只把关键帧值归零，避免改动 motion3 的计数元数据。
function zeroCurveValues(curve) {
  const s = curve.Segments ?? []
  if (s.length > 1) s[1] = 0
  let i = 2
  while (i < s.length) {
    const type = s[i]
    if (type === 1) {                    // Bezier：两个控制点 + 终点
      if (i + 6 >= s.length) break
      s[i + 2] = 0; s[i + 4] = 0; s[i + 6] = 0
      i += 7
    } else if (type === 0 || type === 2 || type === 3) {
      if (i + 2 >= s.length) break       // Linear / Stepped / InverseStepped
      s[i + 2] = 0
      i += 3
    } else {
      throw new Error('未知 motion3 插值类型：' + type)
    }
  }
}

export function patchMotions(files) {
  const out = Object.fromEntries(Object.entries(files).map(([name, json]) => [
    name, typeof json === 'string' ? JSON.parse(json) : structuredClone(json),
  ]))
  for (const motion of Object.values(out))
    for (const curve of motion.Curves ?? [])
      if (curve.Target === 'Parameter' && (curve.Id === 'ParamArmL' || curve.Id === 'ParamArmR'))
        zeroCurveValues(curve)
  return out
}

export async function download(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error('download ' + url + ' → ' + r.status)
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
}

export async function setupOverlay({
  // 素材库与 dsh-plugins/ 平级：~/Desktop/Nothing/live2d-deepseek-whale-girl/cubism
  src = process.env.NICO_LIVE2D_SRC
        ?? join(PLUGIN_DIR, '..', '..', 'live2d-deepseek-whale-girl', 'cubism'),
  rt = join(NICO_DIR, 'rt'),
} = {}) {
  const live2d = join(rt, 'live2d'), overlay = join(rt, 'overlay')
  if (!existsSync(join(src, 'model3.json')))
    throw new Error('Live2D 素材不存在：' + src + '（设 NICO_LIVE2D_SRC 指向 cubism/ 目录）')
  mkdirSync(live2d, { recursive: true }); mkdirSync(overlay, { recursive: true })

  for (const f of ['DeepseekWhaleGirl.moc3', 'DeepseekWhaleGirl.4096.png',
                   'userdata3.json'])
    if (existsSync(join(src, f))) cpSync(join(src, f), join(live2d, f))
  // physics3.json 走补丁写（Normalization 形状修正，见 patchPhysics）
  if (existsSync(join(src, 'physics3.json')))
    writeFileSync(join(live2d, 'physics3.json'),
      JSON.stringify(patchPhysics(readFileSync(join(src, 'physics3.json'), 'utf8'))))
  if (!existsSync(join(src, 'motions')) || !existsSync(join(src, 'exp')))
    throw new Error('素材不完整：缺 motions 或 exp（检查 NICO_LIVE2D_SRC 指向的 cubism 目录）')
  const motionFiles = Object.fromEntries(readdirSync(join(src, 'motions'))
    .filter((f) => f.endsWith('.motion3.json'))
    .map((f) => [f, readFileSync(join(src, 'motions', f), 'utf8')]))
  mkdirSync(join(live2d, 'motions'), { recursive: true })
  for (const [file, json] of Object.entries(patchMotions(motionFiles)))
    writeFileSync(join(live2d, 'motions', file), JSON.stringify(json))
  const expFiles = Object.fromEntries(EXP_NAMES.map((name) => {
    const file = name + '.exp3.json'
    return [file, readFileSync(join(src, 'exp', file), 'utf8')]
  }))
  mkdirSync(join(live2d, 'exp'), { recursive: true })
  for (const [file, json] of Object.entries(patchExpressions(expFiles)))
    writeFileSync(join(live2d, 'exp', file), JSON.stringify(json))
  writeFileSync(join(live2d, 'model3.json'),
    JSON.stringify(patchModel3(readFileSync(join(src, 'model3.json'), 'utf8'))))

  // M3: 原子部署——先在 rt/overlay.tmp 拼装（整目录拷贝 + CDN 下载），全部成功后
  // 才 rmSync 旧 overlay + rename 上位。中途任何一步失败，旧部署原样可用。
  // （cpSync 不删目标里的陈旧文件，如旧单页 overlay.html/overlay.js，必须整目录替换。）
  const libs = [
    ['live2dcubismcore.min.js', 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'],
    ['pixi.min.js', 'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js'],
    ['cubism4.min.js', 'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js'],
  ]
  const dlInto = (dir) => Promise.all(libs.map(([name, url]) => download(url, join(dir, name))))
  if (existsSync(join(PLUGIN_DIR, 'native', 'overlay'))) {
    const tmp = join(rt, 'overlay.tmp')
    try {
      rmSync(tmp, { recursive: true, force: true })
      cpSync(join(PLUGIN_DIR, 'native', 'overlay'), tmp, { recursive: true })
      await dlInto(tmp)
      rmSync(overlay, { recursive: true, force: true })
      renameSync(tmp, overlay)
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true })   // 失败清掉半成品 staging，旧部署不动
      throw e
    }
  } else {
    // native/overlay 缺目录：跳过页面拷贝（保留旧 overlay 里的既有文件），只补库。
    await dlInto(overlay)
  }
  console.error('setup-overlay: 就绪 → ' + rt)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupOverlay().catch((e) => { console.error(e.message); process.exit(1) })
}
