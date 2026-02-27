import { beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "../index.mjs";

function createKernel() {
  const filters = new Map<string, Array<(current: any, context?: any) => any>>();
  return {
    filters,
    kernel: {
      addFilter(name: string, callback: (current: any, context?: any) => any) {
        const current = filters.get(name) || [];
        current.push(callback);
        filters.set(name, current);
      },
    },
  };
}

describe("communication-sendmail plugin", () => {
  const registerCommunicationProvider = vi.fn();
  const getPluginSetting = vi.fn(async () => null);
  let originalRuntime: string | undefined;

  beforeEach(() => {
    registerCommunicationProvider.mockReset();
    getPluginSetting.mockReset();
    getPluginSetting.mockImplementation(async () => null);
    originalRuntime = process.env.NEXT_RUNTIME;
  });

  it("registers the sendmail communication provider", async () => {
    const { kernel } = createKernel();

    await register(kernel as any, {
      registerCommunicationProvider,
      getPluginSetting,
    } as any);

    expect(registerCommunicationProvider).toHaveBeenCalledTimes(1);
    expect(registerCommunicationProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sendmail",
        channels: ["email"],
        deliver: expect.any(Function),
      }),
    );
  });

  it("skips floating widget when detection banner is disabled", async () => {
    const { kernel, filters } = createKernel();
    getPluginSetting.mockImplementation(async (key: string) => (key === "showDetectionBanner" ? "false" : null));

    await register(kernel as any, {
      registerCommunicationProvider,
      getPluginSetting,
    } as any);

    const widgetFilter = filters.get("admin:floating-widgets")?.[0];
    const existing = [{ id: "existing" }];
    const widgets = await widgetFilter!(existing, {
      page: { isPluginPage: true, pluginId: "communication-sendmail" },
    });

    expect(widgets).toEqual(existing);
  });

  it("adds warning widget on sendmail plugin page when runtime is edge", async () => {
    process.env.NEXT_RUNTIME = "edge";

    const { kernel, filters } = createKernel();

    await register(kernel as any, {
      registerCommunicationProvider,
      getPluginSetting,
    } as any);

    const widgetFilter = filters.get("admin:floating-widgets")?.[0];
    const widgets = await widgetFilter!([], {
      page: { isPluginPage: true, pluginId: "communication-sendmail" },
    });

    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toEqual(
      expect.objectContaining({
        id: "sendmail-detect-warning",
        title: "Sendmail Detection Warning",
      }),
    );
  });

  it("does not add widget outside the sendmail plugin page", async () => {
    const { kernel, filters } = createKernel();

    await register(kernel as any, {
      registerCommunicationProvider,
      getPluginSetting,
    } as any);

    const widgetFilter = filters.get("admin:floating-widgets")?.[0];
    const existing = [{ id: "existing" }];
    const widgets = await widgetFilter!(existing, {
      page: { isPluginPage: true, pluginId: "another-plugin" },
    });

    expect(widgets).toEqual(existing);
  });

  afterEach(() => {
    if (originalRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalRuntime;
    }
  });
});
