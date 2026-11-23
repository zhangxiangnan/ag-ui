import type { BrowserControl } from "./handoff";

/** Deterministic browser stand-in. No Chrome, CDP, cookies, or real login. */
export class BrowserFixture implements BrowserControl {
  mode: "agent" | "transferring" | "human" | "closed" = "agent";
  reads = 0;
  private ready = false;
  private inFlight?: Promise<unknown>;

  async agentOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mode !== "agent" || this.inFlight) throw new Error("Agent cannot control browser");
    const work = Promise.resolve().then(operation);
    this.inFlight = work;
    try {
      return await work;
    } finally {
      this.inFlight = undefined;
    }
  }

  async giveToHuman() {
    if (this.mode !== "agent") throw new Error("Browser is not agent-owned");
    this.mode = "transferring";
    await this.inFlight;
    this.mode = "human";
  }

  async returnToAgent() {
    if (this.mode !== "human") throw new Error("Browser is not human-owned");
    // Fixture input is synchronous. A real driver must await outstanding human input.
    this.mode = "agent";
  }

  manualStepComplete() {
    return this.ready;
  }

  performManualStep() {
    if (this.mode !== "human") throw new Error("Human cannot control browser");
    this.ready = true;
  }

  readAsAgent() {
    return this.agentOperation(async () => {
      if (!this.ready) throw new Error("Manual step incomplete");
      this.reads++;
      return "The manual browser step is complete. Agent continued once.";
    });
  }

  close() {
    this.mode = "closed";
  }
}
