import { createServer } from "node:http";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { BrowserHandoff, HandoffRejected } from "./handoff";

/** Loopback test/demo transport. Fixed principal models prior host authentication. */
export async function serve(handoff: BrowserHandoff, principal: string) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/run") {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const parsed = RunAgentInputSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!parsed.success) {
        res.writeHead(400).end("Invalid run input");
        return;
      }
      const events = await handoff.run(principal, parsed.data);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      });
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) {
      res
        .writeHead(error instanceof HandoffRejected ? 409 : 400)
        .end(error instanceof HandoffRejected ? error.message : "Invalid request");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback address");
  return {
    url: `http://127.0.0.1:${address.port}/run`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
