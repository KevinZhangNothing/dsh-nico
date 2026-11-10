import z from '@deepseek-ai/schemastery'

// Host-visible plugin configuration. Volatile leaves are served through the
// GUI configForms service and may be edited without replacing the plugin entry.
const Config = z.object({
  // Session bootstrap message, sent once when Nico's fixed headless session
  // is first created. Empty → built-in default. Written by the settings GUI
  // (volatile leaf); dsh.mjs reads it via NicoSettings.greeting().
  greeting: z.string().default('').volatile(),
  autoStart: z.boolean().default(true),
  maxSec: z.number().default(30),
  speak: z.boolean().default(true),
  bubble: z.boolean().default(true),
  reasoning: z.object({
    provider: z.string().default('').volatile(),
    model: z.string().default('').volatile(),
  }).default({ provider: '', model: '' }),
  stt: z.object({
    // Empty means "not migrated yet"; NicoSettings resolves it to the saved
    // file selection, then to local. The GUI always writes local or cloud.
    engine: z.union(['', 'local', 'cloud']).default('').volatile(),
    model: z.string().default('').volatile(),
    // Which provider serves the cloud ASR. Empty → follows the selected
    // reasoning provider. The endpoint + key are read from the host's own
    // model config (lib/models.mjs resolveProviderEndpoint), never hardcoded.
    cloudProvider: z.string().default('').volatile(),
  }).default({ engine: '', model: '', cloudProvider: '' }),
  // Speech output. engine '' resolves to 'say' (macOS built-in). 'cosyvoice'
  // routes replies through a local CosyVoice2 deployment exposing the
  // OpenAI-compatible POST /v1/audio/speech; instruct is the CosyVoice2
  // emotion instruction prepended with <|endofprompt|>.
  tts: z.object({
    engine: z.union(['', 'say', 'cosyvoice']).default('').volatile(),
    url: z.string().default('').volatile(),
    model: z.string().default('').volatile(),
    voice: z.string().default('').volatile(),
    instruct: z.string().default('').volatile(),
    speed: z.number().default(1).volatile(),
    // GUI → plugin command channel: the settings GUI may only write volatile
    // leaves (dsh-settings rejects ordinary fields). The plugin listens for
    // 'loader/volatile-update' and the GUI resets install to '' right after.
    // Progress NEVER flows back through settings — runtime configEditor writes
    // can fail the compose check and take the whole host down (seen in the
    // 2026-11-10 host crash); the GUI polls the service probe instead.
    install: z.union(['', 'deploy', 'start', 'stop']).default('').volatile(),
  }).default({ engine: '', url: '', model: '', voice: '', instruct: '', speed: 1, install: '' }),
})

export default Config
