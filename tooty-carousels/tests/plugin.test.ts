import { describe, expect, it, vi } from "vitest";
import manifest from "../plugin.json";
import { register } from "../index.mjs";

describe("tooty-carousels plugin", () => {
  it("declares the carousel content type capability", () => {
    expect(manifest.capabilities.contentTypes).toBe(true);
    expect(manifest.capabilities.adminExtensions).toBe(true);
    expect(manifest.scope).toBe("site");
    expect(manifest.distribution).toBe("community");
    expect(manifest.menuPlacement).toBe("settings");
  });

  it("registers the carousel content type", async () => {
    const registerContentType = vi.fn();
    await register({} as any, { registerContentType } as any);

    expect(registerContentType).toHaveBeenCalledWith({
      key: "carousel",
      label: "Carousel",
      description: "Carousel entries used by themes to render panel-based sliders.",
      showInMenu: false,
    });
  });
});
