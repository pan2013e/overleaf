import { beforeEach, describe, expect, it, vi } from "vitest";
import Path from "node:path";

const modulePath = "../../../../app/src/Features/Codex/CodexAppServerClient.mjs";

describe("CodexAppServerClient", function () {
  beforeEach(function () {
    vi.resetModules();
    vi.doMock("@overleaf/logger", () => ({
      default: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    }));
  });

  it("accepts file-change approvals scoped to the user's Codex workspace", async function () {
    const CodexAppServerClient = (await import(modulePath)).default;
    const userRoot = "/var/lib/overleaf/codex/users/user-1";
    const client = new CodexAppServerClient({
      codexBin: "codex",
      codexHome: Path.join(userRoot, "CODEX_HOME"),
      requestTimeoutMs: 1000,
      userRoot,
    });
    client._send = vi.fn();

    client._handleLine(
      JSON.stringify({
        id: 7,
        method: "item/fileChange/requestApproval",
        params: {
          reason: "apply patch",
          grantRoot: Path.join(userRoot, "workspaces", "run-1", "workspace"),
        },
      }),
    );

    expect(client._send).toHaveBeenCalledOnce();
    expect(client._send.mock.calls[0][0]).to.deep.equal({
      id: 7,
      result: {
        decision: "accept",
      },
    });
  });

  it("declines file-change approvals outside the user's Codex workspace", async function () {
    const CodexAppServerClient = (await import(modulePath)).default;
    const client = new CodexAppServerClient({
      codexBin: "codex",
      codexHome: "/var/lib/overleaf/codex/users/user-1/CODEX_HOME",
      requestTimeoutMs: 1000,
      userRoot: "/var/lib/overleaf/codex/users/user-1",
    });
    client._send = vi.fn();

    client._handleLine(
      JSON.stringify({
        id: 8,
        method: "item/fileChange/requestApproval",
        params: {
          reason: "apply patch",
          grant_root: "/tmp/workspace",
        },
      }),
    );

    expect(client._send).toHaveBeenCalledOnce();
    expect(client._send.mock.calls[0][0]).to.deep.equal({
      id: 8,
      result: {
        decision: "decline",
      },
    });
  });
});
