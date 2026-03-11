import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInFlightPluginResetsForTesting,
  createPluginRegistry,
  type PluginRecord,
} from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

const mockPerformGatewaySessionReset = vi.fn();
const mockResolveSessionStoreKey = vi.fn(({ sessionKey }: { sessionKey: string }) =>
  sessionKey.toLowerCase(),
);

vi.mock("../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: (...args: unknown[]) =>
    mockPerformGatewaySessionReset(...(args as [never])),
}));

vi.mock("../gateway/session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/session-utils.js")>()),
  resolveSessionStoreKey: (...args: unknown[]) => mockResolveSessionStoreKey(...(args as [never])),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePluginRecord(id = "test-plugin"): PluginRecord {
  return {
    id,
    name: id,
    source: `/tmp/${id}/index.js`,
    origin: "global",
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

function makeSuccessResult(key: string, sessionId = "session-123") {
  return {
    ok: true as const,
    key,
    entry: {
      sessionId,
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    },
  };
}

const dummyLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const dummyRuntime = {
  version: "test",
} as unknown as PluginRuntime;

describe("api.resetSession", () => {
  let resetSession: NonNullable<
    ReturnType<ReturnType<typeof createPluginRegistry>["createApi"]>["resetSession"]
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPerformGatewaySessionReset.mockReset();
    mockResolveSessionStoreKey.mockReset();
    clearInFlightPluginResetsForTesting();
    mockResolveSessionStoreKey.mockImplementation(({ sessionKey }: { sessionKey: string }) =>
      sessionKey.toLowerCase(),
    );
    const registry = createPluginRegistry({
      logger: dummyLogger,
      runtime: dummyRuntime,
    });
    const api = registry.createApi(makePluginRecord(), {
      config: { session: {} } as never,
    });
    resetSession = api.resetSession as NonNullable<typeof api.resetSession>;
  });

  it("returns an error for non-string keys", async () => {
    const result = await (resetSession as (key: unknown) => ReturnType<typeof resetSession>)(123);
    expect(result).toEqual({ ok: false, key: "", error: "key required" });
    expect(mockPerformGatewaySessionReset).not.toHaveBeenCalled();
  });

  it("returns an error for empty keys", async () => {
    await expect(resetSession("")).resolves.toEqual({ ok: false, key: "", error: "key required" });
    await expect(resetSession("   ")).resolves.toEqual({
      ok: false,
      key: "",
      error: "key required",
    });
    expect(mockPerformGatewaySessionReset).not.toHaveBeenCalled();
  });

  it('trims keys and defaults the reason to "new"', async () => {
    mockPerformGatewaySessionReset.mockResolvedValue(
      makeSuccessResult("agent:test:main", "session-new"),
    );

    await expect(resetSession("  Main  ")).resolves.toEqual({
      ok: true,
      key: "agent:test:main",
      sessionId: "session-new",
    });
    expect(mockResolveSessionStoreKey).toHaveBeenCalledWith({
      cfg: { session: {} },
      sessionKey: "Main",
    });
    expect(mockPerformGatewaySessionReset).toHaveBeenCalledWith({
      key: "Main",
      reason: "new",
      commandSource: "plugin:test-plugin",
    });
  });

  it('forwards an explicit "reset" reason', async () => {
    mockPerformGatewaySessionReset.mockResolvedValue(makeSuccessResult("agent:test:main"));

    await resetSession("main", "reset");

    expect(mockPerformGatewaySessionReset).toHaveBeenCalledWith({
      key: "main",
      reason: "reset",
      commandSource: "plugin:test-plugin",
    });
  });

  it("normalizes gateway failure results to plugin error strings", async () => {
    mockPerformGatewaySessionReset.mockResolvedValue({
      ok: false,
      error: { message: "Session main is still active; try again in a moment." },
    });

    await expect(resetSession("main")).resolves.toEqual({
      ok: false,
      key: "main",
      error: "Session main is still active; try again in a moment.",
    });
  });

  it("normalizes thrown errors to plugin error strings", async () => {
    mockPerformGatewaySessionReset.mockRejectedValue(new Error("kaboom"));

    await expect(resetSession("main")).resolves.toEqual({
      ok: false,
      key: "main",
      error: "kaboom",
    });
  });

  it("applies the in-flight guard to canonicalized keys", async () => {
    const first = deferred<ReturnType<typeof makeSuccessResult>>();
    mockResolveSessionStoreKey.mockImplementation(() => "agent:test:main");
    mockPerformGatewaySessionReset.mockImplementationOnce(() => first.promise);

    const firstCall = resetSession("Main");
    const secondCall = await resetSession("agent:test:main");

    expect(secondCall).toEqual({
      ok: false,
      key: "agent:test:main",
      error: "reset already in progress for agent:test:main",
    });

    first.resolve(makeSuccessResult("agent:test:main", "session-first"));
    await expect(firstCall).resolves.toEqual({
      ok: true,
      key: "agent:test:main",
      sessionId: "session-first",
    });
    expect(mockPerformGatewaySessionReset).toHaveBeenCalledTimes(1);
  });

  it("allows concurrent resets for different canonical keys", async () => {
    const alpha = deferred<ReturnType<typeof makeSuccessResult>>();
    mockResolveSessionStoreKey.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => `canon:${sessionKey.toLowerCase()}`,
    );
    mockPerformGatewaySessionReset
      .mockImplementationOnce(() => alpha.promise)
      .mockResolvedValueOnce(makeSuccessResult("canon:beta", "session-beta"));

    const alphaCall = resetSession("alpha");
    const betaCall = await resetSession("beta");

    alpha.resolve(makeSuccessResult("canon:alpha", "session-alpha"));

    await expect(alphaCall).resolves.toEqual({
      ok: true,
      key: "canon:alpha",
      sessionId: "session-alpha",
    });
    expect(betaCall.ok).toBe(true);
  });

  it("releases the in-flight guard after a failed reset", async () => {
    mockResolveSessionStoreKey.mockReturnValue("agent:test:main");
    mockPerformGatewaySessionReset
      .mockResolvedValueOnce({
        ok: false,
        error: { message: "temporary failure" },
      })
      .mockResolvedValueOnce(makeSuccessResult("agent:test:main", "session-second"));

    await expect(resetSession("main")).resolves.toEqual({
      ok: false,
      key: "agent:test:main",
      error: "temporary failure",
    });
    await expect(resetSession("main")).resolves.toEqual({
      ok: true,
      key: "agent:test:main",
      sessionId: "session-second",
    });
    expect(mockPerformGatewaySessionReset).toHaveBeenCalledTimes(2);
  });
});
