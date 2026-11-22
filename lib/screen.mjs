// Screen awareness — the "say this" feature: when a spoken command refers to
// what is currently on screen ("这个报错是什么", "看看我的屏幕", "帮我把这个
// 窗口关了"), capture the screen once and hand the fixed session a file path
// so it can look before answering. Mirrors nico.app's glance-at-your-window
// behavior: no copying, no describing the setup.
//
// Privacy: the capture is written to a per-use temp directory (read_image needs
// a path), and the file is deleted as soon as the session turn finishes. It is
// never moved under NICO_HOME and never uploaded anywhere else. If the host
// lacks Screen Recording permission (screencapture fails), the command still
// runs — just without the screenshot, exactly like before.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const execFileP = promisify(execFile)

// Trigger detection. Deliberately conservative on the left side (explicit
// screen/look wording) but accepts the bare demonstrative uses that nico.app
// builds its pitch around: "这是什么", "这个报错…", "帮我把这个窗口…"。
const SCREEN_RE = new RegExp([
  // 看屏幕类：看看屏幕 / 看一下我的画面 / 瞅一眼当前窗口
  '(看看?|瞧一?眼|看一?眼|看一?下|读一?下|帮我看).{0,8}(屏幕|画面|显示器|当前窗口|界面|桌面)',
  // 直接指称屏幕内容
  '我的?屏幕|屏幕(上|里|中)的?|当前(窗口|界面|页面|屏幕)',
  // 「这个…是什么/怎么回事」疑问
  '(这个|这是|这些|这里)(报错|错误|窗口|页面|界面|弹窗|提示|对话框|按钮|菜单|文件)?[^，。！？]{0,12}(是什么|什么意思|啥意思|怎么回事|怎么办|为什么|为啥)',
  // 句首的「这个/这是」或「帮我把这个…」——指物代词，截图只有本地成本
  '^这个|^这是|^这些|，这个|,这个|帮我把?这个',
  // English
  "what('s| is) (this|that|on)|this (error|window|screen|dialog|page)|my screen|on (my )?screen",
].join('|'), 'i')

export function wantsScreen(text) {
  return SCREEN_RE.test(String(text || ''))
}

const HINT = (png) =>
  '（说话时我正看着电脑屏幕；屏幕截图保存在 ' + png +
  '，请先用 read_image 工具查看截图，结合屏幕内容回答，不要提截图文件本身。）'

// One capture per command. Resolves null (and the command proceeds text-only)
// when screencapture is missing, unauthorized, or writes nothing.
export async function captureScreen({ bin = 'screencapture' } = {}) {
  let dir
  try { dir = mkdtempSync(join(tmpdir(), 'nico-screen-')) } catch { return null }
  const png = join(dir, 'screen.png')
  try {
    // -x silent (no camera shutter sound); -t png explicit format.
    await execFileP(bin, ['-x', '-t', 'png', png], { timeout: 5000 })
  } catch {
    return null
  }
  return existsSync(png) ? png : null
}

// Returns { text, png }: text is the command enriched with the screenshot hint
// (or unchanged when the trigger misses / the capture fails); png is the temp
// file for the caller to delete after the session turn. `capture` is injectable
// for tests.
export async function attachScreen(text, { capture = captureScreen } = {}) {
  if (!wantsScreen(text)) return { text, png: null }
  const png = await capture()
  if (!png) return { text, png: null }
  return { text: text + ' ' + HINT(png), png }
}

// Delete the capture (and its private temp dir) once the session turn is done.
export function cleanupScreen(png) {
  if (!png) return
  try { unlinkSync(png) } catch {}
  try { rmdirSync(dirname(png)) } catch {}
}
