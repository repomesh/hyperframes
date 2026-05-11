/**
 * compileStage — pure compile pass of `executeRenderJob`.
 *
 * Runs `compileForRender` on the entry HTML, applies render-mode hints
 * (which may flip `cfg.forceScreenshot` on for compositions that need it),
 * writes compiled artifacts to `workDir/compiled/`, builds the
 * `CompositionMetadata` view of the result, and resolves the
 * `deviceScaleFactor` for supersampling.
 *
 * The probe sub-stage (browser launch, duration discovery, recompile,
 * media reconciliation) is extracted separately in PR 1.3. This stage
 * stops at the point where the in-process renderer formerly entered the
 * `if (needsBrowser)` branch.
 *
 * Hard constraints preserved verbatim from the in-process renderer:
 *   - `applyRenderModeHints(cfg, ...)` is allowed to mutate `cfg.forceScreenshot`.
 *   - `perfStages.compileOnlyMs` is set to wall-clock ms around the
 *     `compileForRender` call only.
 *   - The `log.info("Compiled composition metadata", ...)` line is emitted
 *     after writing artifacts, with the same payload shape as before.
 *   - The `log.info("Supersampling composition via deviceScaleFactor", ...)`
 *     line is emitted only when `deviceScaleFactor > 1`.
 */

import { join } from "node:path";
import type { EngineConfig } from "@hyperframes/engine";
import type { CompiledComposition } from "../../htmlCompiler.js";
import { compileForRender } from "../../htmlCompiler.js";
import type { ProducerLogger } from "../../../logger.js";
import {
  applyRenderModeHints,
  resolveDeviceScaleFactor,
  writeCompiledArtifacts,
  type CompositionMetadata,
  type RenderJob,
} from "../../renderOrchestrator.js";

export interface CompileStageInput {
  projectDir: string;
  workDir: string;
  /** Absolute path to the entry HTML (already resolved to standalone-entry if needed). */
  htmlPath: string;
  /** The relative `entryFile` string, used only for log payloads. */
  entryFile: string;
  job: RenderJob;
  /** EngineConfig — may be mutated via `cfg.forceScreenshot = true`. */
  cfg: EngineConfig;
  /** True when the output format requires an alpha channel (webm/mov/png-sequence). */
  needsAlpha: boolean;
  log: ProducerLogger;
  /** Cooperative-cancellation probe; throws `RenderCancelledError` when aborted. */
  assertNotAborted: () => void;
}

export interface CompileStageResult {
  compiled: CompiledComposition;
  composition: CompositionMetadata;
  deviceScaleFactor: number;
  outputWidth: number;
  outputHeight: number;
  /** Wall-clock ms for the pure `compileForRender` call only (excludes artifact writes). */
  compileOnlyMs: number;
}

export async function runCompileStage(input: CompileStageInput): Promise<CompileStageResult> {
  const { projectDir, workDir, htmlPath, entryFile, job, cfg, needsAlpha, log, assertNotAborted } =
    input;

  const compileStart = Date.now();
  const compiled = await compileForRender(projectDir, htmlPath, join(workDir, "downloads"));
  assertNotAborted();
  const compileOnlyMs = Date.now() - compileStart;
  applyRenderModeHints(cfg, compiled, log);
  writeCompiledArtifacts(compiled, workDir, Boolean(job.config.debug));

  log.info("Compiled composition metadata", {
    entryFile,
    staticDuration: compiled.staticDuration,
    width: compiled.width,
    height: compiled.height,
    videoCount: compiled.videos.length,
    audioCount: compiled.audios.length,
    renderModeHints: compiled.renderModeHints,
  });

  const composition: CompositionMetadata = {
    duration: compiled.staticDuration,
    videos: compiled.videos,
    audios: compiled.audios,
    images: compiled.images,
    width: compiled.width,
    height: compiled.height,
  };
  const { width, height } = composition;
  const deviceScaleFactor = resolveDeviceScaleFactor({
    compositionWidth: width,
    compositionHeight: height,
    outputResolution: job.config.outputResolution,
    hdrRequested: job.config.hdrMode === "force-hdr",
    alphaRequested: needsAlpha,
  });
  const outputWidth = width * deviceScaleFactor;
  const outputHeight = height * deviceScaleFactor;
  if (deviceScaleFactor > 1) {
    log.info("Supersampling composition via deviceScaleFactor", {
      compositionWidth: width,
      compositionHeight: height,
      outputResolution: job.config.outputResolution,
      outputWidth,
      outputHeight,
      deviceScaleFactor,
    });
  }

  return { compiled, composition, deviceScaleFactor, outputWidth, outputHeight, compileOnlyMs };
}
