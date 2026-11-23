import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { HttpAgent } from "@ag-ui/client";
import { BrowserFixture } from "./browser-fixture";
import { BrowserHandoff } from "./handoff";
import { serve } from "./server";

async function main() {
  const browser = new BrowserFixture();
  const handoff = new BrowserHandoff(browser, "demo-user", "demo-thread");
  const server = await serve(handoff, "demo-user");
  let prompt: ReturnType<typeof createInterface> | undefined;
  try {
    const agent = new HttpAgent({ url: server.url, threadId: "demo-thread" });
    await agent.runAgent({ runId: "request-human" });
    const interrupt = agent.pendingInterrupts[0]!;
    console.log("Run ended with interrupt; browser control:", browser.mode);
    console.log("This is a browser fixture, not a real login session.");
    let choice = "continue";
    if (!process.argv.includes("--auto")) {
      prompt = createInterface({ input: stdin, output: stdout });
      choice = await prompt.question("Enter continue to simulate the manual step, or cancel: ");
    }
    if (choice.trim() === "continue") {
      handoff.manualStep("demo-user", "demo-thread", interrupt.id);
    }
    await agent.runAgent({
      runId: "answer-human",
      resume: [
        {
          interruptId: interrupt.id,
          status: choice.trim() === "continue" ? "resolved" : "cancelled",
          ...(choice.trim() === "continue" ? { payload: { action: "continue" } } : {}),
        },
      ],
    });
    console.log(
      JSON.stringify(
        {
          browser: browser.mode,
          agentReads: browser.reads,
          pendingInterrupts: agent.pendingInterrupts,
          messages: agent.messages,
        },
        null,
        2,
      ),
    );
  } finally {
    prompt?.close();
    browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
