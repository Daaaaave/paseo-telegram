import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { UserFacingError } from "./errors.ts";
import { dataRoot } from "./paths.ts";

const run = promisify(execFile);

export interface Transcriber {
  /** Returns the spoken text of an audio file, or throws a UserFacingError. */
  transcribe(audioPath: string, signal?: AbortSignal): Promise<string>;
}

export interface TranscriberSettings {
  ffmpeg: string;
  whisper: string;
  model: string;
  timeoutMs: number;
}

/** Fully local: ffmpeg converts, whisper.cpp transcribes. No network call and
 * no API key. Paths can be overridden with environment variables. */
export function transcriberSettings(
  env: NodeJS.ProcessEnv = process.env,
): TranscriberSettings {
  return {
    ffmpeg: env.PASEO_TELEGRAM_FFMPEG || "/opt/homebrew/bin/ffmpeg",
    whisper: env.PASEO_TELEGRAM_WHISPER_CLI || "/opt/homebrew/bin/whisper-cli",
    model:
      env.PASEO_TELEGRAM_WHISPER_MODEL ||
      join(dataRoot, "models", "ggml-large-v3-turbo.bin"),
    timeoutMs: 600_000,
  };
}

const NOT_READY =
  "Voice transcription is not set up on this computer (whisper.cpp, ffmpeg or the model is missing).";

/** Whisper marks silence and noise with bracketed tags such as [BLANK_AUDIO]. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[A-Z_ ]+\]|\((?:music|silence|noise)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class WhisperTranscriber implements Transcriber {
  private readonly settings: TranscriberSettings;
  private gate: Promise<unknown> = Promise.resolve();
  constructor(settings: TranscriberSettings = transcriberSettings()) {
    this.settings = settings;
  }
  /** One transcription at a time: whisper is CPU/GPU heavy. */
  transcribe(audioPath: string, signal?: AbortSignal): Promise<string> {
    const task = this.gate.then(() => this.convertAndRecognise(audioPath, signal));
    this.gate = task.catch(() => {});
    return task;
  }
  private async convertAndRecognise(
    audioPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { ffmpeg, whisper, model, timeoutMs } = this.settings;
    for (const required of [ffmpeg, whisper, model])
      await access(required).catch(() => {
        throw new UserFacingError(NOT_READY);
      });
    const work = await mkdtemp(join(tmpdir(), "paseo-telegram-"));
    try {
      const wav = join(work, "audio.wav");
      const options = { signal, timeout: timeoutMs, maxBuffer: 8_000_000 };
      await run(
        ffmpeg,
        ["-nostdin", "-v", "error", "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
        options,
      ).catch(() => {
        throw new UserFacingError("This audio file could not be read.");
      });
      const { stdout } = await run(
        whisper,
        ["-m", model, "-f", wav, "-l", "auto", "-nt", "-np"],
        options,
      ).catch(() => {
        throw new UserFacingError("The voice message could not be transcribed.");
      });
      return cleanTranscript(stdout);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
