// Media-button state machine for analog headsets whose microphone is muted while
// the call button is held. A long hold arms recording on release; the next press
// stops it. Short presses retain media play/pause when not recording.
export class MediaHold {
  constructor({ thresholdMs = 400, onShort = () => {}, onToggleStart = () => {}, onToggleStop = () => {} } = {}) {
    this.thresholdMs = thresholdMs
    this.onShort = onShort
    this.onToggleStart = onToggleStart
    this.onToggleStop = onToggleStop
    this.state = 'idle'
    this.since = 0
    this.recording = false
    this.enabled = true
  }

  down(now) {
    if (!this.enabled) return
    if (this.state !== 'idle') return
    this.state = 'pending'
    this.since = now
  }

  up(now) {
    if (!this.enabled) return
    if (this.state === 'pending') {
      this.state = 'idle'
      this.onShort()
    } else if (this.state === 'holding') {
      this.state = 'idle'
      if (this.recording) {
        this.recording = false
        this.onToggleStop()
      } else {
        this.recording = true
        this.onToggleStart()
      }
    }
  }

  tick(now) {
    if (!this.enabled || this.state !== 'pending' || now - this.since < this.thresholdMs) return
    this.state = 'holding'
  }

  stop() {
    this.enabled = false
    this.recording = false
    this.state = 'idle'
  }
}
