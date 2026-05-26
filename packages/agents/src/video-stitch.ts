// ffmpeg helpers for the multi-clip video pipeline.
//
// We spawn the static ffmpeg binary bundled by `ffmpeg-static`. On Vercel
// this lands the binary inside the function bundle (~45MB on linux-x64).
//
// Two operations live here:
//   1. extractLastFrameJpeg — grabs the final frame of a clip so it can be
//      fed as `imageUrl` into the NEXT clip's generation call. This is the
//      mechanism that makes stitched clips read as one continuous shot.
//   2. concatMp4s          — joins N clips into one MP4. Uses filter_complex
//      concat with a re-encode so it works even when clips have slightly
//      different timebases / pixel formats (Veo vs Sora vs Replicate).
//
// All work happens in `os.tmpdir()`. Caller never sees file paths.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";

import ffmpegPathDefault from "ffmpeg-static";

const log = pino({ name: "video-stitch" });

// `ffmpeg-static` exports `string | null` (null on unsupported platforms).
// We resolve once at import-time and let any caller see a clear error if
// the binary failed to land during install.
function resolveFfmpegPath(): string {
  const p = (ffmpegPathDefault as unknown as string | null) ?? null;
  if (!p) {
    throw new Error(
      "ffmpeg-static did not provide a binary path on this platform — install scripts may have been blocked. Run `pnpm approve-builds` and reinstall.",
    );
  }
  return p;
}

async function runFfmpeg(args: string[]): Promise<void> {
  const bin = resolveFfmpegPath();
  log.debug({ args: args.join(" ") }, "ffmpeg invoke");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `ffmpeg exited with code ${code}. args=${args.join(" ")} stderr=${stderr.slice(-800)}`,
        ),
      );
    });
  });
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "video-stitch-"));
  try {
    return await fn(dir);
  } finally {
    // Best-effort cleanup. Leaving a tmp dir around isn't catastrophic; the
    // OS will reap it eventually.
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extract the final frame of an MP4 as a JPEG. Used to seed the NEXT clip's
 * generation call as the `imageUrl` (image-to-video), which is how we
 * make adjacent beats read as one continuous shot.
 */
export async function extractLastFrameJpeg(
  mp4Bytes: Uint8Array,
): Promise<Uint8Array> {
  return withTmpDir(async (dir) => {
    const inPath = path.join(dir, "clip.mp4");
    const outPath = path.join(dir, "last.jpg");
    await fs.writeFile(inPath, mp4Bytes);

    // -sseof -0.1 seeks to 0.1s before the end of the file, then -vframes 1
    // grabs the single decoded frame at that point. Quality 2 keeps the
    // JPEG clean enough to feed back into a video model.
    await runFfmpeg([
      "-y",
      "-sseof",
      "-0.1",
      "-i",
      inPath,
      "-vframes",
      "1",
      "-q:v",
      "2",
      outPath,
    ]);

    const out = await fs.readFile(outPath);
    log.info({ inBytes: mp4Bytes.byteLength, outBytes: out.byteLength }, "extracted last frame");
    return new Uint8Array(out);
  });
}

/**
 * Concat N MP4 clips into one MP4. Re-encodes to a common h264 + aac
 * profile so the result plays back consistently regardless of which video
 * provider produced each clip. Reads the output's duration via ffprobe-
 * style frame count so callers can stamp `durationSec` on the asset row.
 *
 * Returns null if `clips` is empty (caller should treat that as a failure
 * upstream — there is nothing useful to upload).
 */
export async function concatMp4s(
  clips: Uint8Array[],
): Promise<{ bytes: Uint8Array; durationSec: number } | null> {
  if (clips.length === 0) return null;
  if (clips.length === 1) {
    // Single clip: skip ffmpeg entirely. Caller still wants a durationSec
    // — best-effort by probing the single file. If probing fails we fall
    // back to a conservative 8s estimate (the provider cap).
    const only = clips[0]!;
    const dur = await probeDurationSec(only).catch(() => 8);
    return { bytes: only, durationSec: dur };
  }
  return withTmpDir(async (dir) => {
    const inputArgs: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const p = path.join(dir, `clip-${i}.mp4`);
      await fs.writeFile(p, clips[i]!);
      inputArgs.push("-i", p);
    }
    const outPath = path.join(dir, "out.mp4");

    // Build the filter graph: [0:v][0:a][1:v][1:a]…concat=n=N:v=1:a=1[v][a]
    // Some video providers may return clips without an audio stream (Veo
    // preview models, t2v Replicate models). Concat with `a=1` requires
    // every input to HAVE an audio track — otherwise ffmpeg errors out.
    // We detect missing-audio clips by probing in parallel and fall back
    // to video-only concat when ANY input lacks audio.
    const hasAudioFlags = await Promise.all(
      clips.map((_, i) => hasAudioStream(path.join(dir, `clip-${i}.mp4`))),
    );
    const allHaveAudio = hasAudioFlags.every(Boolean);
    const parts: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      parts.push(`[${i}:v:0]`);
      if (allHaveAudio) parts.push(`[${i}:a:0]`);
    }
    const filter = allHaveAudio
      ? `${parts.join("")}concat=n=${clips.length}:v=1:a=1[v][a]`
      : `${parts.join("")}concat=n=${clips.length}:v=1:a=0[v]`;

    const args: string[] = [
      "-y",
      ...inputArgs,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
    ];
    if (allHaveAudio) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "128k");
    args.push(
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-movflags",
      "+faststart",
      outPath,
    );

    log.info(
      { clipCount: clips.length, allHaveAudio },
      "stitching clips into final MP4",
    );
    await runFfmpeg(args);

    const out = await fs.readFile(outPath);
    const dur = await probeDurationSecFromPath(outPath).catch(() => clips.length * 8);
    log.info(
      { clipCount: clips.length, outBytes: out.byteLength, durationSec: dur },
      "stitched final MP4",
    );
    return { bytes: new Uint8Array(out), durationSec: dur };
  });
}

// Probe duration via `ffmpeg -i` stderr parsing. We avoid bundling a separate
// ffprobe binary — ffmpeg-static only ships ffmpeg, and the stderr `Duration:`
// line is stable enough across versions to grep.
async function probeDurationSec(bytes: Uint8Array): Promise<number> {
  return withTmpDir(async (dir) => {
    const p = path.join(dir, "probe.mp4");
    await fs.writeFile(p, bytes);
    return probeDurationSecFromPath(p);
  });
}

async function probeDurationSecFromPath(filePath: string): Promise<number> {
  const bin = resolveFfmpegPath();
  return new Promise<number>((resolve, reject) => {
    const child = spawn(bin, ["-i", filePath, "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", () => {
      // Look for "Duration: HH:MM:SS.MS" line — present even when ffmpeg
      // exits with a non-zero code due to `-f null -` being a sink.
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!m) {
        reject(new Error("could not parse Duration from ffmpeg stderr"));
        return;
      }
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      const ss = Number(m[3]);
      resolve(hh * 3600 + mm * 60 + ss);
    });
  });
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  const bin = resolveFfmpegPath();
  return new Promise<boolean>((resolve) => {
    const child = spawn(bin, ["-i", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve(false));
    child.on("close", () => {
      // `Stream #0:1[0x2](und): Audio: aac…` — the presence of any "Audio:"
      // stream-list line is enough to confirm an audio track.
      resolve(/Stream #\d+:\d+.*Audio:/i.test(stderr));
    });
  });
}
