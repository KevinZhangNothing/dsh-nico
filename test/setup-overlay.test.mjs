import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchModel3, patchPhysics, patchExpressions, patchMotions, EXP_NAMES } from '../scripts/setup-overlay.mjs'

test('patchModel3 按文件序修正 expression Name（构建脚本把 8 个都写成了"普通"）', () => {
  const model3 = { FileReferences: { Expressions: [
    { Name: '普通', File: 'exp/f01_normal.exp3.json' },
    { Name: '普通', File: 'exp/f02_smile.exp3.json' },
    { Name: '普通', File: 'exp/f08_sleepy.exp3.json' },
  ] } }
  const out = patchModel3(model3)
  assert.equal(out.FileReferences.Expressions[0].Name, 'f01_normal')
  assert.equal(out.FileReferences.Expressions[1].Name, 'f02_smile')
  assert.equal(out.FileReferences.Expressions[2].Name, 'f08_sleepy')
})

test('patchModel3 不修改传入对象（structuredClone 深拷贝）', () => {
  const model3 = { FileReferences: { Expressions: [
    { Name: '普通', File: 'exp/f01_normal.exp3.json' },
  ] } }
  patchModel3(model3)
  assert.equal(model3.FileReferences.Expressions[0].Name, '普通')
})

test('patchModel3 接受 JSON 字符串入参', () => {
  const out = patchModel3(JSON.stringify({ FileReferences: { Expressions: [
    { Name: '普通', File: 'exp/f03_angry.exp3.json' },
  ] } }))
  assert.equal(out.FileReferences.Expressions[0].Name, 'f03_angry')
})

test('patchModel3 复制 Textures 为两份且相同（moc3 drawable 纹理索引 1-based，单张声明会让索引 1 越界 → 黑剪影）', () => {
  const out = patchModel3({ FileReferences: {
    Textures: [{ Texture: 'DeepseekWhaleGirl.4096.png' }],
    Expressions: [],
  } })
  const tex = out.FileReferences.Textures
  assert.equal(tex.length, 2)
  assert.deepEqual(tex[0], tex[1])
})

test('patchPhysics 修正素材库写歪的 Normalization（Position/Angle 需为 {Minimum,Default,Maximum}）', () => {
  const out = patchPhysics({ PhysicsSettings: [
    { Id: 'PhysicsSetting1', Normalization: { Position: { X: 0, Y: 0 }, Angle: 0 } },
    { Id: 'PhysicsSetting2' },
  ] })
  for (const s of out.PhysicsSettings) {
    assert.deepEqual(s.Normalization.Position, { Minimum: -1, Default: 0, Maximum: 1 })
    assert.deepEqual(s.Normalization.Angle, { Minimum: -30, Default: 0, Maximum: 30 })
  }
})

test('patchPhysics 对已规范的 Normalization 是空操作', () => {
  const norm = { Position: { Minimum: -2, Default: 0, Maximum: 2 }, Angle: { Minimum: -45, Default: 0, Maximum: 45 } }
  const out = patchPhysics({ PhysicsSettings: [{ Id: 'x', Normalization: norm }] })
  assert.deepEqual(out.PhysicsSettings[0].Normalization, norm)
})

test('patchPhysics 不修改传入对象', () => {
  const input = { PhysicsSettings: [{ Id: 'x', Normalization: { Position: { X: 0, Y: 0 }, Angle: 0 } }] }
  patchPhysics(input)
  assert.deepEqual(input.PhysicsSettings[0].Normalization, { Position: { X: 0, Y: 0 }, Angle: 0 })
})

test('patchPhysics 等比降低过大的输出增益，避免发丝参数饱和', () => {
  const out = patchPhysics({ PhysicsSettings: [
    { Output: [{ Scale: 9 }, { Scale: 4.5 }] },
    { Output: [{ Scale: 7.5 }] },
  ] })
  const scales = out.PhysicsSettings.flatMap((s) => s.Output.map((o) => o.Scale))
  assert.equal(scales[0], 2)
  assert.equal(scales[1], 1)
  assert(Math.abs(scales[2] - 2 * 7.5 / 9) < 1e-12)
})

test('patchPhysics 官方量级（<=2）的输出增益不再改动', () => {
  const out = patchPhysics({ PhysicsSettings: [{ Output: [{ Scale: 1.522 }, { Scale: -2 }] }] })
  assert.deepEqual(out.PhysicsSettings[0].Output.map((o) => o.Scale), [1.522, -2])
})

test('patchExpressions 改 Overwrite、补全复位参数并剥离头身角度', () => {
  const out = patchExpressions({
    'f01_normal.exp3.json': { Parameters: [
      { Id: 'ParamEyeStyle', Value: 0, Blend: 'Add' },
      { Id: 'ParamAngleY', Value: 8, Blend: 'Add' },
    ] },
    'f03_angry.exp3.json': JSON.stringify({ Parameters: [
      { Id: 'ParamEyeStyle', Value: 2, Blend: 'Add' },
      { Id: 'ParamBrowStyle', Value: 1, Blend: 'Add' },
      { Id: 'ParamEyeROpen', Value: 0, Blend: 'Add' },
    ] }),
  })
  const normal = out['f01_normal.exp3.json'].Parameters
  const angry = out['f03_angry.exp3.json'].Parameters
  assert(!normal.some((p) => p.Id === 'ParamAngleY'))
  assert.equal(normal.find((p) => p.Id === 'ParamBrowStyle').Value, 0)
  assert.equal(normal.find((p) => p.Id === 'ParamEyeROpen').Value, 1)
  assert.equal(angry.find((p) => p.Id === 'ParamBrowStyle').Value, 1)
  for (const exp of Object.values(out)) {
    assert.equal(exp.FadeInTime, 0)
    assert.equal(exp.FadeOutTime, 0)
    for (const p of exp.Parameters) assert.equal(p.Blend, 'Overwrite')
  }
})

test('patchExpressions 不修改传入对象', () => {
  const input = { 'f01_normal.exp3.json': { Parameters: [{ Id: 'ParamEyeStyle', Value: 0, Blend: 'Add' }] } }
  patchExpressions(input)
  assert.equal(input['f01_normal.exp3.json'].Parameters[0].Blend, 'Add')
})

test('patchMotions 冻结左右手臂关键帧且保留时间轴/其他曲线', () => {
  const out = patchMotions({ 'idle.motion3.json': { Curves: [
    { Target: 'Parameter', Id: 'ParamArmL', Segments: [0, 0, 0, 0.5, -0.13, 0, 1, -0.25] },
    { Target: 'Parameter', Id: 'ParamArmR', Segments: [0, 0.2, 1, 0.4, 0.3, 0.6, 0.4, 0.8, 0.2] },
    { Target: 'Parameter', Id: 'ParamAngleY', Segments: [0, 0, 0, 0.5, 3, 0, 1, -3] },
  ] } })
  const [l, r, angle] = out['idle.motion3.json'].Curves
  assert.deepEqual(l.Segments, [0, 0, 0, 0.5, 0, 0, 1, 0])
  assert.deepEqual(r.Segments, [0, 0, 1, 0.4, 0, 0.6, 0, 0.8, 0])
  assert.deepEqual(angle.Segments, [0, 0, 0, 0.5, 3, 0, 1, -3])
})

test('patchMotions 接受 JSON 字符串且不修改入参', () => {
  const input = { 'nod.motion3.json': JSON.stringify({ Curves: [
    { Target: 'Parameter', Id: 'ParamArmL', Segments: [0, 0.5, 0, 1, 1] },
  ] }) }
  const out = patchMotions(input)
  assert.deepEqual(out['nod.motion3.json'].Curves[0].Segments, [0, 0, 0, 1, 0])
  assert(JSON.parse(input['nod.motion3.json']).Curves[0].Segments[1] === 0.5)
})

test('patchModel3 无 File 时回退 EXP_NAMES 按序', () => {
  const out = patchModel3({ FileReferences: { Expressions: [
    { Name: '普通' },
    { Name: '普通' },
  ] } })
  assert.equal(out.FileReferences.Expressions[0].Name, EXP_NAMES[0])
  assert.equal(out.FileReferences.Expressions[1].Name, EXP_NAMES[1])
})
