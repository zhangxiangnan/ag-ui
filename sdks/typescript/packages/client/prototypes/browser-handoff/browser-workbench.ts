import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { HttpAgent } from "@ag-ui/client";
import { type BaseEvent } from "@ag-ui/core";
import { BrowserHandoff, type BrowserControl } from "./handoff";
import { serve } from "./server";

/** Cooperative local-page driver, NOT CDP or a driver for arbitrary websites. */
class PageDriver implements BrowserControl {
  stream?: ServerResponse;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  async call(method: string): Promise<unknown> {
    const stream = this.stream;
    if (!stream || stream.destroyed) throw new Error("Browser disconnected");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Browser acknowledgement timed out"));
      }, 8000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      stream.write(`data: ${JSON.stringify({ id, method })}\n\n`);
    });
  }
  reply(id: string, value: unknown, error?: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve(value);
  }
  disconnect() {
    this.stream = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error("Browser disconnected"));
    this.pending.clear();
  }
  async giveToHuman() {
    await this.call("giveToHuman");
  }
  async returnToAgent() {
    await this.call("returnToAgent");
  }
  async manualStepComplete() {
    return (await this.call("manualStepComplete")) === true;
  }
  performManualStep(): void {
    throw new Error("Use the real page controls");
  }
  async readAsAgent() {
    const value = await this.call("readAsAgent");
    if (typeof value !== "string") throw new Error("Invalid browser result");
    return value;
  }
  async close() {
    await this.call("close");
  }
}

async function main() {
  // Each tab gets its own driver/thread; a stale tab cannot answer another tab's RPC.
  const sessions = new Map<
    string,
    {
      driver: PageDriver;
      client: HttpAgent;
      transport: Awaited<ReturnType<typeof serve>>;
      events: BaseEvent[];
      busy: boolean;
    }
  >();
  const html = await readFile(new URL("./browser-workbench.html", import.meta.url));
  let origin = "";
  const server = createServer(async (req, res) => {
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.method === "POST" && req.headers.origin !== origin)
      ) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url!, origin);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(html);
        return;
      }
      const id = url.searchParams.get("session") || "";
      if (req.method === "POST" && url.pathname === "/session") {
        const sessionId = randomUUID();
        const driver = new PageDriver();
        const transport = await serve(
          new BrowserHandoff(driver, "local-user", sessionId, Date.now, 600_000),
          "local-user",
        );
        const client = new HttpAgent({ url: transport.url, threadId: sessionId });
        sessions.set(sessionId, { driver, client, transport, events: [], busy: false });
        res.end(JSON.stringify({ id: sessionId }));
        return;
      }
      const session = sessions.get(id);
      if (!session) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/driver") {
        if (session.driver.stream) {
          res.writeHead(409).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write(": connected\n\n");
        session.driver.stream = res;
        res.on("close", () => session.driver.disconnect());
        return;
      }
      if (req.method === "GET" && url.pathname === "/status") {
        res.end(
          JSON.stringify({
            busy: session.busy,
            events: session.events,
            pending: session.client.pendingInterrupts,
            messages: session.client.messages,
          }),
        );
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) {
          res.writeHead(413).end();
          return;
        }
      }
      const data = JSON.parse(body || "{}");
      if (url.pathname === "/reply") {
        session.driver.reply(data.id, data.value, data.error);
        res.end("{}");
        return;
      }
      if (url.pathname === "/action") {
        if (session.busy) {
          res.writeHead(409).end("Transition already running");
          return;
        }
        if (!["start", "continue", "cancel"].includes(data.action)) {
          res.writeHead(400).end();
          return;
        }
        const interrupt = session.client.pendingInterrupts[0];
        if (data.action !== "start" && !interrupt) {
          res.writeHead(409).end("No pending interrupt");
          return;
        }
        session.busy = true;
        try {
          await session.client.runAgent(
            {
              runId: randomUUID(),
              ...(data.action === "start"
                ? {}
                : {
                    resume: [
                      {
                        interruptId: interrupt!.id,
                        status:
                          data.action === "cancel" ? ("cancelled" as const) : ("resolved" as const),
                        ...(data.action === "continue" ? { payload: { action: "continue" } } : {}),
                      },
                    ],
                  }),
            },
            {
              onEvent: ({ event }) => {
                session.events.push(event);
              },
            },
          );
          res.end("{}");
        } finally {
          session.busy = false;
        }
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(409).end(error instanceof Error ? error.message : "Request failed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  origin = `http://127.0.0.1:${address.port}`;
  console.log(`Browser handoff workbench: ${origin}`);
  // Sessions are intentionally process-local; stop this test server after use.
  process.once("SIGINT", async () => {
    for (const session of sessions.values()) {
      session.driver.stream?.end();
      session.driver.disconnect();
      await session.transport.close();
    }
    server.closeAllConnections();
    server.close();
  });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
