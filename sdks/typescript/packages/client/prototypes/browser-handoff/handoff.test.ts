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

describe("asynchronous browser acknowledgements", () => {
  function asyncFixture() {
    const browser = new BrowserFixture();
    const driver = {
      giveToHuman: () => browser.giveToHuman(),
      returnToAgent: () => browser.returnToAgent(),
      manualStepComplete: vi.fn(async () => browser.manualStepComplete()),
      performManualStep: () => browser.performManualStep(),
      readAsAgent: () => browser.readAsAgent(),
      close: vi.fn(async () => browser.close()),
    };
    const host = new BrowserHandoff(driver, "alice", "thread");
    return { browser, driver, host };
  }
  it("awaits false readiness and permits retry with the same unconsumed run ID", async () => {
    const { browser, host } = asyncFixture();
    const { interrupt } = await request(host);
    await expect(host.run("alice", answer(interrupt.id))).rejects.toThrow("manual step");
    expect(browser.mode).toBe("human");
    expect(browser.reads).toBe(0);
    browser.performManualStep();
    const events = await host.run("alice", answer(interrupt.id));
    expect(events.at(-1)).toMatchObject({ outcome: { type: "success" } });
    expect(browser.reads).toBe(1);
  });
  it("locks before awaiting readiness, rejecting simultaneous handback and cancel", async () => {
    const { browser, driver, host } = asyncFixture();
    const { interrupt } = await request(host);
    browser.performManualStep();
    const gate = deferred();
    driver.manualStepComplete.mockImplementationOnce(async () => {
      await gate.promise;
      return true;
    });
    const first = host.run("alice", answer(interrupt.id));
    await expect(
      host.run("alice", { ...answer(interrupt.id, "cancelled"), runId: "other" }),
    ).rejects.toThrow("transition");
    gate.resolve();
    await first;
    expect(browser.reads).toBe(1);
  });
  it("does not report cancellation until close acknowledges revocation", async () => {
    const { browser, driver, host } = asyncFixture();
    const { interrupt } = await request(host);
    const gate = deferred();
    driver.close.mockImplementation(async () => {
      await gate.promise;
      browser.close();
    });
    let settled = false;
    const run = host.run("alice", answer(interrupt.id, "cancelled")).then((events) => {
      settled = true;
      return events;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(browser.mode).toBe("human");
    gate.resolve();
    expect((await run).at(-1)).toMatchObject({ outcome: { type: "cancelled" } });
    expect(browser.mode).toBe("closed");
    expect(browser.reads).toBe(0);
  });
  it("reports unknown control on failed close, without retrying or claiming cancellation", async () => {
    const { browser, driver, host } = asyncFixture();
    const { interrupt } = await request(host);
    driver.close.mockRejectedValue(new Error("private driver details"));
    const events = await host.run("alice", answer(interrupt.id, "cancelled"));
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "Browser control failed; cleanup was not confirmed.",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ content: { control: "unknown", status: "failed" } }),
    );
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private driver details");
    expect(driver.close).toHaveBeenCalledTimes(1);
    expect(browser.reads).toBe(0);
    await expect(host.run("alice", input("retry"))).rejects.toThrow("closed");
  });
  it("awaits the second readiness check before any agent read", async () => {
    const { browser, driver, host } = asyncFixture();
    const { interrupt } = await request(host);
    browser.performManualStep();
    driver.manualStepComplete.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const events = await host.run("alice", answer(interrupt.id));
    expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
    expect(browser.reads).toBe(0);
    expect(browser.mode).toBe("closed");
  });
  it("keeps the interrupt after RUN_ERROR; the host terminal state still forbids another handback", async () => {
    const { browser, driver, host } = asyncFixture();
    const server = await serve(host, "alice");
    cleanups.push(server.close);
    const client = new HttpAgent({ url: server.url, threadId: "thread" });
    await client.runAgent({ runId: "request" });
    const interrupt = client.pendingInterrupts[0]!;
    browser.performManualStep();
    driver.manualStepComplete.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const events: BaseEvent[] = [];
    await client.runAgent(
      { runId: "answer", resume: answer(interrupt.id).resume },
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );
    expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
    expect(client.pendingInterrupts).toHaveLength(1);
    expect(client.messages).toMatchObject([{ content: { control: "none", status: "failed" } }]);
    expect(browser.reads).toBe(0);
    await expect(host.run("alice", { ...answer(interrupt.id), runId: "retry" })).rejects.toThrow(
      "closed",
    );
  });
  it("releases the lock if the preflight browser probe rejects", async () => {
    const { driver, host } = asyncFixture();
    const { interrupt } = await request(host);
    driver.manualStepComplete.mockRejectedValueOnce(new Error("Browser unavailable"));
    await expect(host.run("alice", answer(interrupt.id))).rejects.toThrow("Browser unavailable");
    const events = await host.run("alice", answer(interrupt.id, "cancelled"));
    expect(events.at(-1)).toMatchObject({ outcome: { type: "cancelled" } });
  });
});
