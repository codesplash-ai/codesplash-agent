import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bytes } from "../core/session/files.ts"
import { reviewTerminalIntegrations, runTerminalCommand, terminalText } from "./terminal-integrations.ts"

export type VoicePhase = "recording" | "transcribing" | "finished" | "cancelled"
export class VoiceCapture {
  readonly #abort = new AbortController()
  readonly #stop = new AbortController()
  phase: VoicePhase = "recording"
  #started = false
  stop(): void {
    this.#stop.abort()
  }
  cancel(): void {
    this.phase = "cancelled"
    this.#abort.abort(new Error("Dictation cancelled"))
  }
  async run(directory: string, cwd: string, onPhase: (phase: VoicePhase) => void): Promise<string> {
    if (this.#started) throw new Error("Voice capture already started")
    this.#started = true
    const review = reviewTerminalIntegrations(directory),
      voice = review.config.voice
    if (!voice) throw new Error("Configure voice.record and voice.transcribe in terminal-integrations.json")
    if (!review.trusted) throw new Error("Review and accept voice commands with /terminal before recording")
    for (const argv of [voice.record, voice.transcribe])
      if (!argv.some((part) => part.includes("{audio}")))
        throw new Error("Voice commands must contain {audio}")
    const temp = await mkdtemp(join(tmpdir(), "codesplash-voice-")),
      path = join(temp, "audio.wav")
    const substitute = (argv: string[]) => argv.map((part) => part.replaceAll("{audio}", path))
    const timer = setTimeout(() => this.stop(), 60000)
    try {
      await chmod(temp, 0o700)
      this.#abort.signal.throwIfAborted()
      onPhase("recording")
      await runTerminalCommand(substitute(voice.record), {
        cwd,
        signal: this.#abort.signal,
        gracefulStop: this.#stop.signal,
        timeoutMs: 63000,
      })
      clearTimeout(timer)
      this.#abort.signal.throwIfAborted()
      const audio = bytes(path, 16 * 1024 * 1024)
      if (
        audio.length < 44 ||
        audio.toString("ascii", 0, 4) !== "RIFF" ||
        audio.toString("ascii", 8, 12) !== "WAVE"
      )
        throw new Error(
          "Recorder did not produce a bounded WAV file; check microphone permissions and device selection",
        )
      const current = reviewTerminalIntegrations(directory)
      if (!current.trusted || current.fingerprint !== review.fingerprint)
        throw new Error("Voice configuration changed during recording; review again")
      this.phase = "transcribing"
      onPhase(this.phase)
      const output = await runTerminalCommand(substitute(voice.transcribe), {
        cwd,
        signal: this.#abort.signal,
        timeoutMs: 120000,
        maxBytes: 16384,
      })
      this.#abort.signal.throwIfAborted()
      const text = terminalText(output, 8000).trim()
      if (!text) throw new Error("Transcriber returned no speech; draft preserved")
      this.phase = "finished"
      onPhase(this.phase)
      return text
    } finally {
      clearTimeout(timer)
      await rm(temp, { recursive: true, force: true })
    }
  }
}

export async function voiceDiagnostics(directory: string, cwd: string): Promise<string> {
  let review: ReturnType<typeof reviewTerminalIntegrations>
  try {
    review = reviewTerminalIntegrations(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return "No voice backend configured. Create terminal-integrations.json in the user config directory; see /docs → Terminal workspace."
    throw error
  }
  const voice = review.config.voice
  if (!voice)
    return "No voice backend configured. Set recorder/transcriber argv with {audio} in terminal-integrations.json, then /terminal to review."
  const status = `Executables: ${review.executables.join(", ")}\nReviewed: ${review.trusted}\nCapture limit: 60 seconds · WAV limit: 16 MiB · transcription limit: 120 seconds`
  if (!review.trusted) return `${status}\nMicrophone diagnostics require /terminal review.`
  if (!voice.diagnostic)
    return `${status}\nNo microphone diagnostic command configured. /voice start explicitly attempts capture; failure preserves the draft.`
  const output = await runTerminalCommand(voice.diagnostic, {
    cwd,
    timeoutMs: 10000,
    maxBytes: 32768,
    captureStderr: true,
    acceptNonzero: true,
  })
  return `${status}\nMicrophone diagnostic output:\n${terminalText(output, 16000)}`
}
