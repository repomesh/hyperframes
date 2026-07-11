import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@hyperframes/core/compiler", () => ({
  bundleToSingleHtml: vi.fn(async () => "<html><body>bundled</body></html>"),
}));

import { bundleWithLocalizedFonts } from "./bundleWithLocalizedFonts.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("bundleWithLocalizedFonts", () => {
  it("runs the injected font localizer over the plain bundle", async () => {
    const localize = vi.fn(async (html: string) => html.replace("bundled", "bundled+fonts"));
    const html = await bundleWithLocalizedFonts("/project", localize);
    expect(localize).toHaveBeenCalledOnce();
    expect(localize).toHaveBeenCalledWith("<html><body>bundled</body></html>");
    expect(html).toBe("<html><body>bundled+fonts</body></html>");
  });

  it("returns the localizer's output verbatim (localization is the last step)", async () => {
    const html = await bundleWithLocalizedFonts(
      "/project",
      async () => "<html>embedded-face</html>",
    );
    expect(html).toBe("<html>embedded-face</html>");
  });
});
