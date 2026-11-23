import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunFinishedEvent, type RunAgentInput } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";
import { BrowserFixture } from "./browser-fixture";
import { BrowserHandoff } from "./handoff";
import { serve } from "./server";

const input = (runId: string, resume?: RunAgentInput["resume"]): RunAgentInput => ({
  threadId: "thread",
  runId,
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
  ...(resume ? { resume } : {}),
});
const answer = (id: string, status: "resolved" | "cancelled" = "resolved") =>
  input("answer", [{ interruptId: id, status, payload: { action: "continue" } }]);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture() {
  const browser = new BrowserFixture();
  let clock = Date.now();
  const host = new BrowserHandoff(browser, "alice", "thread", () => clock, 60_000);
  return {
    browser,
    host,
    expire: () => {
      clock += 60_000;
    },
  };
}
async function request(host: BrowserHandoff) {
  const events = await host.run("alice", input("request"));
  const last = events.at(-1) as RunFinishedEvent;
  EventSchema.parse(last);
  if (last.type !== EventType.RUN_FINISHED || last.outcome?.type !== "interrupt") {
    throw new Error("Expected interrupt outcome");
  }
  return { events, interrupt: last.outcome.interrupts[0]! };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

describe("browser handoff recipe", () => {
  it("ends the requesting run, preserving human control after the SSE response ends", async () => {
    const { browser, host } = fixture();
    const server = await serve(host, "alice");
    cleanups.push(server.close);
    const client = new HttpAgent({ url: server.url, threadId: "thread" });
    const seen: BaseEvent[] = [];
    await client.runAgent(
      { runId: "request" },
      {
        onEvent: ({ event }) => {
          seen.push(event);
        },
      },
    );
    expect(seen.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    for (const event of seen) expect(EventSchema.safeParse(event).success).toBe(true);
    expect(client.pendingInterrupts).toHaveLength(1);
    expect(client.messages).toMatchObject([{ role: "activity", content: { control: "human" } }]);
    expect(browser.mode).toBe("human");
    expect(browser.reads).toBe(0);
    await expect(browser.readAsAgent()).rejects.toThrow("Agent cannot control");
  });

  it("continues through HttpAgent on a new run, replacing one activity and reading once", async () => {
    const { browser, host } = fixture();
    const server = await serve(host, "alice");
    cleanups.push(server.close);
    const client = new HttpAgent({ url: server.url, threadId: "thread" });
    await client.runAgent({ runId: "request" });
    const interrupt = client.pendingInterrupts[0]!;
    host.manualStep("alice", "thread", interrupt.id);
    const seen: BaseEvent[] = [];
    await client.runAgent(
      { runId: "answer", resume: answer(interrupt.id).resume },
      {
        onEvent: ({ event }) => {
          seen.push(event);
        },
      },
    );
    for (const event of seen) expect(EventSchema.safeParse(event).success).toBe(true);
    expect(seen[0]).toMatchObject({ runId: "answer", threadId: "thread" });
    expect(seen.at(-1)).toMatchObject({ outcome: { type: "success" } });
    expect(client.pendingInterrupts).toEqual([]);
    expect(client.messages.filter((message) => message.role === "activity")).toHaveLength(1);
    expect(client.messages).toMatchObject([
      { role: "activity", content: { control: "none", status: "completed" } },
      { role: "assistant", content: expect.stringContaining("continued once") },
    ]);
    expect(browser.reads).toBe(1);
    expect(browser.mode).toBe("closed");
  });

  it("drains an in-flight agent command before granting human input", async () => {
    const { browser, host } = fixture();
    const gate = deferred();
    const action = browser.agentOperation(() => gate.promise);
    const waiting = request(host);
    expect(browser.mode).toBe("transferring");
    expect(() => browser.performManualStep()).toThrow("Human cannot control");
    await expect(browser.agentOperation(async () => undefined)).rejects.toThrow(
      "Agent cannot control",
    );
    await expect(host.run("alice", input("concurrent"))).rejects.toThrow("already running");
    gate.resolve();
    await action;
    await waiting;
    expect(browser.mode).toBe("human");
  });

  it("does not trust a resume payload as evidence of successful manual work", async () => {
    const { browser, host } = fixture();
    const { interrupt } = await request(host);
    await expect(host.run("alice", answer(interrupt.id))).rejects.toThrow("not completed");
    expect(browser.mode).toBe("human");
    expect(browser.reads).toBe(0);
    host.manualStep("alice", "thread", interrupt.id);
    await host.run("alice", answer(interrupt.id));
    expect(browser.reads).toBe(1);
  });

  it.each(["missing", "unknown", "duplicate"])(
    "rejects %s answers without releasing human control",
    async (kind) => {
      const { browser, host } = fixture();
      const { interrupt } = await request(host);
      const good = answer(interrupt.id).resume![0]!;
      const resume =
        kind === "missing"
          ? []
          : kind === "unknown"
            ? [{ ...good, interruptId: "old" }]
            : [good, good];
      await expect(host.run("alice", input("answer", resume))).rejects.toThrow("exactly once");
      expect(browser.mode).toBe("human");
      expect(browser.reads).toBe(0);
    },
  );

  it.each(["owner", "thread"])("rejects the wrong %s on both control channels", async (kind) => {
    const { host, browser } = fixture();
    const { interrupt } = await request(host);
    const principal = kind === "owner" ? "bob" : "alice";
    const threadId = kind === "thread" ? "other" : "thread";
    expect(() => host.manualStep(principal, threadId, interrupt.id)).toThrow(
      "Wrong owner or thread",
    );
    await expect(host.run(principal, { ...answer(interrupt.id), threadId })).rejects.toThrow(
      "Wrong owner or thread",
    );
    expect(browser.mode).toBe("human");
  });

  it("rejects stale manual input and a reused run ID", async () => {
    const { host, browser } = fixture();
    const { interrupt } = await request(host);
    expect(() => host.manualStep("alice", "thread", "old")).toThrow("matching human");
    host.manualStep("alice", "thread", interrupt.id);
    await expect(host.run("alice", { ...answer(interrupt.id), runId: "request" })).rejects.toThrow(
      "already used",
    );
    expect(browser.reads).toBe(0);
  });

  it("rejects expired handback and input, but allows explicit abandonment", async () => {
    const { host, browser, expire } = fixture();
    const { interrupt } = await request(host);
    host.manualStep("alice", "thread", interrupt.id);
    expire();
    expect(() => host.manualStep("alice", "thread", interrupt.id)).toThrow("expired");
    await expect(host.run("alice", answer(interrupt.id))).rejects.toThrow("expired");
    const events = await host.run("alice", answer(interrupt.id, "cancelled"));
    expect(events.at(-1)).toMatchObject({ outcome: { type: "cancelled" } });
    expect(browser.reads).toBe(0);
    expect(browser.mode).toBe("closed");
  });

  it("cancels through the public client without performing the agent action", async () => {
    const { host, browser } = fixture();
    const server = await serve(host, "alice");
    cleanups.push(server.close);
    const client = new HttpAgent({ url: server.url, threadId: "thread" });
    await client.runAgent({ runId: "request" });
    await client.runAgent({
      runId: "cancel",
      resume: answer(client.pendingInterrupts[0]!.id, "cancelled").resume,
    });
    expect(client.pendingInterrupts).toEqual([]);
    expect(client.messages).toMatchObject([{ role: "activity", content: { status: "cancelled" } }]);
    expect(browser.mode).toBe("closed");
    expect(browser.reads).toBe(0);
  });

  it("serializes concurrent handbacks and blocks human input during transfer", async () => {
    const { host, browser } = fixture();
    const { interrupt } = await request(host);
    host.manualStep("alice", "thread", interrupt.id);
    const gate = deferred();
    vi.spyOn(browser, "returnToAgent").mockImplementation(async () => {
      browser.mode = "transferring";
      await gate.promise;
      browser.mode = "agent";
    });
    const first = host.run("alice", answer(interrupt.id));
    await expect(host.run("alice", { ...answer(interrupt.id), runId: "racing" })).rejects.toThrow(
      "already running",
    );
    expect(() => host.manualStep("alice", "thread", interrupt.id)).toThrow("matching human");
    gate.resolve();
    await first;
    await expect(host.run("alice", { ...answer(interrupt.id), runId: "replayed" })).rejects.toThrow(
      "closed",
    );
    expect(browser.reads).toBe(1);
  });

  it("fails closed if the lease expires while handback drains", async () => {
    const { host, browser, expire } = fixture();
    const { interrupt } = await request(host);
    host.manualStep("alice", "thread", interrupt.id);
    vi.spyOn(browser, "returnToAgent").mockImplementation(async () => {
      expire();
      browser.mode = "agent";
    });
    const events = await host.run("alice", answer(interrupt.id));
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
    expect(browser.reads).toBe(0);
    expect(browser.mode).toBe("closed");
  });

  it("rechecks browser readiness after outstanding human input drains", async () => {
    const { host, browser } = fixture();
    const { interrupt } = await request(host);
    host.manualStep("alice", "thread", interrupt.id);
    vi.spyOn(browser, "manualStepComplete").mockReturnValueOnce(true).mockReturnValue(false);
    const events = await host.run("alice", answer(interrupt.id));
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
    expect(browser.reads).toBe(0);
    expect(browser.mode).toBe("closed");
  });

  it.each(["giveToHuman", "returnToAgent", "readAsAgent"] as const)(
    "fails closed on %s failure",
    async (method) => {
      const { host, browser } = fixture();
      let next = input("request");
      if (method !== "giveToHuman") {
        const { interrupt } = await request(host);
        host.manualStep("alice", "thread", interrupt.id);
        next = answer(interrupt.id);
      }
      vi.spyOn(browser, method).mockRejectedValue(new Error("private browser details"));
      const events = await host.run("alice", next);
      for (const event of events) expect(EventSchema.safeParse(event).success).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        code: "BROWSER_HANDOFF_FAILED",
      });
      expect(JSON.stringify(events)).not.toContain("private browser details");
      expect(browser.mode).toBe("closed");
      await expect(host.run("alice", input("again"))).rejects.toThrow("closed");
    },
  );

  it("copies emitted interrupt objects and rejects unexpected resume fields", async () => {
    const { host, browser } = fixture();
    const { interrupt } = await request(host);
    host.manualStep("alice", "thread", interrupt.id);
    const id = interrupt.id;
    interrupt.id = "tampered";
    await expect(
      host.run(
        "alice",
        input("bad", [
          { interruptId: id, status: "resolved", payload: { action: "continue", cookie: "no" } },
        ]),
      ),
    ).rejects.toThrow("Expected only");
    await host.run("alice", answer(id));
    expect(browser.reads).toBe(1);
  });

  it("rejects resume before any handoff exists", async () => {
    const { host, browser } = fixture();
    await expect(host.run("alice", answer("invented"))).rejects.toThrow("No interrupt");
    expect(browser.mode).toBe("agent");
  });
});
