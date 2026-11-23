import { randomUUID } from "node:crypto";
import {
  EventType,
  type ActivitySnapshotEvent,
  type BaseEvent,
  type Interrupt,
  type RunAgentInput,
} from "@ag-ui/core";

/** Application-owned operations, NOT a proposed AG-UI browser API. */
export interface BrowserControl {
  // Revoke new agent commands, drain in-flight commands, then grant human input.
  giveToHuman(): Promise<void>;
  // Revoke human input and drain it before granting agent commands.
  returnToAgent(): Promise<void>;
  // Read authoritative browser state, including after human input has drained.
  manualStepComplete(): boolean | Promise<boolean>;
  performManualStep(): void;
  readAsAgent(): Promise<string>;
  // Idempotent revocation; completion confirms input is revoked and drained.
  close(): void | Promise<void>;
}

export class HandoffRejected extends Error {}

/** One authenticated owner's one thread/browser; intentionally in-memory. */
export class BrowserHandoff {
  private phase: "new" | "waiting" | "done" | "failed" = "new";
  private busy = false;
  private pending?: Interrupt;
  private readonly activityId = randomUUID();
  private readonly usedRuns = new Set<string>();

  constructor(
    private readonly browser: BrowserControl,
    private readonly owner: string,
    private readonly threadId: string,
    private readonly now: () => number = Date.now,
    private readonly lifetimeMs = 60_000,
  ) {}

  private authorize(principal: string, threadId: string) {
    if (principal !== this.owner || threadId !== this.threadId) {
      throw new HandoffRejected("Wrong owner or thread");
    }
  }

  /** Separate host control channel; never carry credentials through resume. */
  manualStep(principal: string, threadId: string, interruptId: string) {
    this.authorize(principal, threadId);
    if (this.busy || this.phase !== "waiting" || interruptId !== this.pending?.id) {
      throw new HandoffRejected("No matching human control lease");
    }
    if (this.expired()) throw new HandoffRejected("Human control lease expired");
    this.browser.performManualStep();
  }

  private expired() {
    return this.now() >= Date.parse(this.pending!.expiresAt!);
  }

  private activity(control: string, status: string): ActivitySnapshotEvent {
    return {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: this.activityId,
      activityType: "example.browser-handoff",
      content: { control, status },
    };
  }

  async run(principal: string, input: RunAgentInput): Promise<BaseEvent[]> {
    this.authorize(principal, input.threadId);
    if (this.busy) throw new HandoffRejected("A control transition is already running");
    if (this.usedRuns.has(input.runId)) throw new HandoffRejected("Run ID already used");
    if (this.phase === "done" || this.phase === "failed") {
      throw new HandoffRejected("This example session is closed");
    }

    const answer = input.resume?.[0];
    if (this.phase === "new") {
      if (input.resume?.length) throw new HandoffRejected("No interrupt to answer");
    } else {
      if (!answer || input.resume?.length !== 1 || answer.interruptId !== this.pending?.id) {
        throw new HandoffRejected("Answer the current interrupt exactly once");
      }
      if (answer.status !== "cancelled") {
        if (answer.status !== "resolved" || this.expired()) {
          throw new HandoffRejected("Invalid or expired handback");
        }
        if (
          !answer.payload ||
          answer.payload.action !== "continue" ||
          Object.keys(answer.payload).length !== 1
        ) {
          throw new HandoffRejected("Expected only { action: 'continue' }");
        }
      }
    }

    // Claim synchronously, before any browser await. Two requests cannot both resume.
    this.busy = true;
    // An asynchronous readiness probe also owns the transition lock. A negative
    // probe is retryable and does not consume the run ID.
    try {
      if (this.phase === "waiting" && answer!.status !== "cancelled") {
        if (!(await this.browser.manualStepComplete())) {
          throw new HandoffRejected("Browser has not completed the manual step");
        }
        if (this.expired()) throw new HandoffRejected("Human control lease expired");
      }
    } catch (error) {
      this.busy = false;
      throw error;
    }
    this.usedRuns.add(input.runId);
    let closeAttempted = false;
    let closed = false;
    const close = async () => {
      closeAttempted = true;
      await this.browser.close();
      closed = true;
    };
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
    ];
    try {
      if (this.phase === "new") {
        await this.browser.giveToHuman();
        this.pending = {
          id: randomUUID(),
          reason: "example.browser-handoff",
          message: "Complete the manual browser step, then return control or cancel.",
          expiresAt: new Date(this.now() + this.lifetimeMs).toISOString(),
          responseSchema: {
            type: "object",
            properties: { action: { const: "continue" } },
            required: ["action"],
            additionalProperties: false,
          },
        };
        this.phase = "waiting";
        events.push(this.activity("human", "waiting"), {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
          outcome: { type: "interrupt", interrupts: [this.pending] },
        } as BaseEvent);
      } else if (answer!.status === "cancelled") {
        await close();
        this.phase = "done";
        this.pending = undefined;
        events.push(this.activity("none", "cancelled"), {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
          outcome: { type: "cancelled" },
        } as BaseEvent);
      } else {
        await this.browser.returnToAgent();
        // Recheck after the drain: a lease may expire while human input settles.
        if (this.expired()) throw new Error("Lease expired during handback");
        if (!(await this.browser.manualStepComplete()))
          throw new Error("Browser changed during handback");
        if (this.expired()) throw new Error("Lease expired during readiness probe");
        events.push(this.activity("agent", "resumed"));
        const result = await this.browser.readAsAgent();
        await close();
        this.phase = "done";
        this.pending = undefined;
        const messageId = randomUUID();
        events.push(
          this.activity("none", "completed"),
          { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent,
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: result } as BaseEvent,
          { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            outcome: { type: "success" },
          } as BaseEvent,
        );
      }
    } catch {
      // Fail closed: no uncertain browser operation is automatically retried.
      this.phase = "failed";
      this.pending = undefined;
      if (!closeAttempted) {
        try {
          await close();
        } catch {
          // No acknowledgement means revocation is unknown, not confirmed.
        }
      }
      events.push(this.activity(closed ? "none" : "unknown", "failed"), {
        type: EventType.RUN_ERROR,
        code: "BROWSER_HANDOFF_FAILED",
        message: closed
          ? "Browser control failed; this example session was closed."
          : "Browser control failed; cleanup was not confirmed.",
      } as BaseEvent);
    } finally {
      this.busy = false;
    }
    // Consumers cannot mutate the host's pending interrupt through an event object.
    return structuredClone(events);
  }
}
