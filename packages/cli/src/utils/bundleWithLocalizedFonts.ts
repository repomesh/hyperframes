/**
 * Bundle a project to a single HTML string AND localize its fonts — fetch and
 * embed `@font-face` rules for every requested family (including families
 * declared only via a remote `<link>`, e.g. Google Fonts) as data URIs.
 *
 * Why the audit/snapshot paths need this: core's `bundleToSingleHtml` inlines
 * only LOCAL stylesheets and leaves remote font `<link>`s as-is, so a snapshot
 * depends on loading the remote font at capture time. The render pipeline
 * instead localizes fonts in its compile stage, which is why a render embeds
 * (say) League Gothic correctly while a snapshot of the same composition can
 * fall back to an un-styled system sans when the remote font loses the race
 * against the capture. Running the SAME localization the render path uses makes
 * snapshot/check captures font-faithful and deterministic — no network race.
 *
 * Fail-open: if a family can't be fetched (offline, unknown font), the
 * underlying injector leaves the HTML unchanged, so this never makes a bundle
 * worse than plain `bundleToSingleHtml`.
 */
export async function bundleWithLocalizedFonts(
  projectDir: string,
  // Injectable for tests. Production callers omit it and get the producer
  // font-localization pass, resolved lazily at runtime (see localizeWithProducer).
  localizeFonts: (html: string) => Promise<string> = localizeWithProducer,
): Promise<string> {
  const { bundleToSingleHtml } = await import("@hyperframes/core/compiler");
  const html = await bundleToSingleHtml(projectDir);
  return localizeFonts(html);
}

/**
 * Run the render pipeline's `injectDeterministicFontFaces` pass, resolving
 * `@hyperframes/producer` at RUNTIME only. The specifier is kept out of the
 * bundler's/test-runner's static module graph (`@vite-ignore` + a variable
 * specifier) on purpose: the CLI test job doesn't build producer, so a static
 * `import("@hyperframes/producer")` would fail Vitest's transform-time
 * resolution. At runtime — the built CLI, or an installed package — producer is
 * a real dependency and resolves via node_modules.
 *
 * Fail-open: if producer can't be resolved or a fetch layer throws, return the
 * HTML unchanged so a bundle is never worse than plain `bundleToSingleHtml`.
 */
async function localizeWithProducer(html: string): Promise<string> {
  try {
    const producerSpecifier = "@hyperframes/producer";
    const { injectDeterministicFontFaces } = (await import(
      /* @vite-ignore */ producerSpecifier
    )) as typeof import("@hyperframes/producer");
    return await injectDeterministicFontFaces(html);
  } catch {
    return html;
  }
}
