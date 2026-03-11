import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginRecord } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi, PluginResetSessionResult } from "./types.js";

type SessionResetDeps = {
  performGatewaySessionReset: ReturnType<typeof vi.fn>;
  resolveGatewaySessionStoreTarget: ReturnType<typeof vi.fn>;
};

type RegistryImportOptions = {
  sessionResetImportError?: Error;
  sessionUtilsImportError?: Error;
};

function createRecord(): PluginRecord {
  return {
    id: "demo-plugin",
    name: "Demo Plugin",
    source: "/tmp/demo-plugin.ts",
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

async function createApiHarness(options?: RegistryImportOptions) {
  vi.resetModules();

  if (options?.sessionResetImportError) {
    vi.doMock("../gateway/session-reset-service.js", () => {
      const mockedModule = {
        performGatewaySessionReset: () => undefined,
      };
      return new Proxy(mockedModule, {
        get(target, prop, receiver) {
          if (prop === "performGatewaySessionReset") {
            throw options.sessionResetImportError;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    });
  }

  if (options?.sessionUtilsImportError) {
    vi.doMock("../gateway/session-utils.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../gateway/session-utils.js")>();
      return new Proxy(actual, {
        get(target, prop, receiver) {
          if (prop === "resolveGatewaySessionStoreTarget") {
            throw options.sessionUtilsImportError;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    });
  }

  const sessionResetService = options?.sessionResetImportError
    ? null
    : await import("../gateway/session-reset-service.js");
  const sessionUtils = options?.sessionUtilsImportError
    ? null
    : await import("../gateway/session-utils.js");

  const deps: SessionResetDeps = {
    performGatewaySessionReset:
      sessionResetService === null
        ? vi.fn()
        : vi.spyOn(sessionResetService, "performGatewaySessionReset"),
    resolveGatewaySessionStoreTarget:
      sessionUtils === null ? vi.fn() : vi.spyOn(sessionUtils, "resolveGatewaySessionStoreTarget"),
  };

  const { createPluginRegistry } = await import("./registry.js");
  const { createApi } = createPluginRegistry({
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    runtime: {} as PluginRuntime,
  });

  const api = createApi(createRecord(), {
    config: {} as OpenClawConfig,
  });

  return { api, deps };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createApiWithDefaultMocks() {
  const harness = await createApiHarness();
  harness.deps.resolveGatewaySessionStoreTarget.mockReturnValue({
    canonicalKey: "agent:main:demo",
  });
  return harness;
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("../gateway/session-reset-service.js");
  vi.doUnmock("../gateway/session-utils.js");
});

describe("plugin resetSession", () => {
  describe("type and API exposure", () => {
    it("keeps the exported API type feature-detectable", () => {
      expectTypeOf<OpenClawPluginApi["resetSession"]>().toEqualTypeOf<
        ((key: string, reason?: "new" | "reset") => Promise<PluginResetSessionResult>) | undefined
      >();
    });

    it("exposes resetSession on the real API object returned by createApi", async () => {
      const { api } = await createApiHarness();

      expect(api).toHaveProperty("resetSession");
      expect(api.resetSession).toBeTypeOf("function");
    });
  });

  describe("validation and success mapping", () => {
    it("normalizes non-string, empty, and whitespace-only keys to failure results", async () => {
      const { api, deps } = await createApiHarness();

      await expect(api.resetSession?.(123 as never)).resolves.toEqual({
        ok: false,
        key: "",
        error: "resetSession key must be a string",
      });
      await expect(api.resetSession?.("")).resolves.toEqual({
        ok: false,
        key: "",
        error: "resetSession key must be a non-empty string",
      });
      await expect(api.resetSession?.("   ")).resolves.toEqual({
        ok: false,
        key: "",
        error: "resetSession key must be a non-empty string",
      });

      expect(deps.resolveGatewaySessionStoreTarget).not.toHaveBeenCalled();
      expect(deps.performGatewaySessionReset).not.toHaveBeenCalled();
    });

    it("trims the key, defaults reason to new, and maps success without leaking gateway internals", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset.mockResolvedValue({
        ok: true,
        key: "agent:main:canonical",
        entry: { sessionId: "session-123", hidden: true },
      });

      const result = await api.resetSession?.("  agent:main:demo  ");

      expect(deps.resolveGatewaySessionStoreTarget).toHaveBeenCalledWith({
        cfg: {},
        key: "agent:main:demo",
      });
      expect(deps.performGatewaySessionReset).toHaveBeenCalledWith({
        key: "agent:main:demo",
        reason: "new",
        commandSource: "plugin:demo-plugin",
      });
      expect(result).toEqual({
        ok: true,
        key: "agent:main:canonical",
        sessionId: "session-123",
      });
      expect(result).not.toHaveProperty("entry");
    });

    it("preserves an explicit reset reason", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset.mockResolvedValue({
        ok: true,
        key: "agent:main:demo",
        entry: { sessionId: "session-456" },
      });

      await api.resetSession?.("agent:main:demo", "reset");

      expect(deps.performGatewaySessionReset).toHaveBeenCalledWith({
        key: "agent:main:demo",
        reason: "reset",
        commandSource: "plugin:demo-plugin",
      });
    });

    it('falls back to "new" for invalid runtime reason values', async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset.mockResolvedValue({
        ok: true,
        key: "agent:main:demo",
        entry: { sessionId: "session-fallback" },
      });

      await expect(api.resetSession?.("agent:main:demo", "invalid" as never)).resolves.toEqual({
        ok: true,
        key: "agent:main:demo",
        sessionId: "session-fallback",
      });

      expect(deps.performGatewaySessionReset).toHaveBeenCalledWith({
        key: "agent:main:demo",
        reason: "new",
        commandSource: "plugin:demo-plugin",
      });
    });
  });

  describe("failure normalization", () => {
    it("normalizes gateway failure objects to string errors", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset.mockResolvedValue({
        ok: false,
        error: { code: "UNAVAILABLE", message: "try again later" },
      });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "try again later",
      });
    });

    it("normalizes helper throws from Error and string values", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset.mockRejectedValueOnce(new Error("boom error"));
      deps.performGatewaySessionReset.mockRejectedValueOnce("boom string");

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "boom error",
      });
      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "boom string",
      });
    });

    it("normalizes canonicalization failure before invoking the reset helper", async () => {
      const { api, deps } = await createApiHarness();
      deps.resolveGatewaySessionStoreTarget.mockImplementation(() => {
        throw new Error("bad session key");
      });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "bad session key",
      });
      expect(deps.performGatewaySessionReset).not.toHaveBeenCalled();
    });

    it("normalizes session-reset import failures", async () => {
      const { api } = await createApiHarness({
        sessionResetImportError: new Error("import setup failed"),
      });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "import setup failed",
      });
    });

    it("normalizes session-utils import/setup failures", async () => {
      const { api } = await createApiHarness({
        sessionUtilsImportError: new Error("session-utils setup failed"),
      });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "session-utils setup failed",
      });
    });

    it("resolves structured failure instead of rejecting for operational failures", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset.mockResolvedValue({
        ok: false,
        error: { message: "gateway rejected" },
      });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "gateway rejected",
      });
    });
  });

  describe("in-flight guard behavior", () => {
    it("blocks same canonical key while a reset is already in flight", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      const pending = deferred<{ ok: true; key: string; entry: { sessionId: string } }>();
      deps.performGatewaySessionReset.mockReturnValue(pending.promise);

      const first = api.resetSession?.("agent:main:demo");
      const second = await api.resetSession?.("agent:main:demo");

      expect(second).toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "Session reset already in progress for agent:main:demo.",
      });

      pending.resolve({
        ok: true,
        key: "agent:main:demo",
        entry: { sessionId: "session-1" },
      });
      await expect(first).resolves.toEqual({
        ok: true,
        key: "agent:main:demo",
        sessionId: "session-1",
      });
    });

    it("allows different canonical keys concurrently", async () => {
      const { api, deps } = await createApiHarness();
      const first = deferred<{ ok: true; key: string; entry: { sessionId: string } }>();
      const second = deferred<{ ok: true; key: string; entry: { sessionId: string } }>();

      deps.resolveGatewaySessionStoreTarget.mockImplementation(({ key }: { key: string }) => ({
        canonicalKey: key,
      }));
      deps.performGatewaySessionReset
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      const firstCall = api.resetSession?.("agent:main:a");
      const secondCall = api.resetSession?.("agent:main:b");

      second.resolve({
        ok: true,
        key: "agent:main:b",
        entry: { sessionId: "session-b" },
      });
      first.resolve({
        ok: true,
        key: "agent:main:a",
        entry: { sessionId: "session-a" },
      });

      await expect(firstCall).resolves.toEqual({
        ok: true,
        key: "agent:main:a",
        sessionId: "session-a",
      });
      await expect(secondCall).resolves.toEqual({
        ok: true,
        key: "agent:main:b",
        sessionId: "session-b",
      });
    });

    it("blocks alias keys that resolve to the same canonical key", async () => {
      const { api, deps } = await createApiHarness();
      const pending = deferred<{ ok: true; key: string; entry: { sessionId: string } }>();

      deps.resolveGatewaySessionStoreTarget.mockImplementation(({ key }: { key: string }) => ({
        canonicalKey: key === "agent:ops:MAIN" ? "agent:ops:work" : key,
      }));
      deps.performGatewaySessionReset.mockReturnValue(pending.promise);

      const first = api.resetSession?.("agent:ops:MAIN");
      const second = await api.resetSession?.("agent:ops:work");

      expect(second).toEqual({
        ok: false,
        key: "agent:ops:work",
        error: "Session reset already in progress for agent:ops:work.",
      });

      pending.resolve({
        ok: true,
        key: "agent:ops:work",
        entry: { sessionId: "session-work" },
      });
      await first;
    });

    it("releases the in-flight guard after success and after failure", async () => {
      const { api, deps } = await createApiWithDefaultMocks();
      deps.performGatewaySessionReset
        .mockResolvedValueOnce({
          ok: true,
          key: "agent:main:demo",
          entry: { sessionId: "session-ok" },
        })
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce({
          ok: true,
          key: "agent:main:demo",
          entry: { sessionId: "session-after-failure" },
        });

      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: true,
        key: "agent:main:demo",
        sessionId: "session-ok",
      });
      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: false,
        key: "agent:main:demo",
        error: "temporary failure",
      });
      await expect(api.resetSession?.("agent:main:demo")).resolves.toEqual({
        ok: true,
        key: "agent:main:demo",
        sessionId: "session-after-failure",
      });
    });
  });
});
