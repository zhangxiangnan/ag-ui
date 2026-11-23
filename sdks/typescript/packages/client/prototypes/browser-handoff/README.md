# Browser human handoff: an AG-UI recipe prototype

This is an **agent-requested** manual browser step expressed with existing AG-UI
1.0 interrupts and Activity events. It proposes an example/documentation
contribution, not a new protocol event or a public browser-control SDK.

The CLI uses a deterministic browser fixture. An additional local workbench
connects a real Chrome page through an asynchronous cooperative page driver.
Both use the real HTTP/SSE transport and `HttpAgent` client path. The workbench
runs HttpAgent in Node, with browser controls and DOM reads in Chrome; it does
not integrate CDP, an external login service, or arbitrary-site automation.

## Run

Use the repository's Node 22 toolchain and installed workspace dependencies.
From the repository root:

```sh
pnpm exec nx run @ag-ui/client:build
pnpm exec tsx sdks/typescript/packages/client/prototypes/browser-handoff/demo.ts
# Noninteractive continuation:
pnpm exec tsx sdks/typescript/packages/client/prototypes/browser-handoff/demo.ts --auto
```

The interactive prompt accepts `continue` to simulate the manual browser step;
any other answer abandons it. The first HTTP response has already ended before
the prompt appears. On continuation the output has one completed Activity, one
assistant message, no pending interrupts and exactly one agent read. Cancellation
closes the fixture without the agent read.

## Ownership and wire flow

1. The host binds one browser to one authenticated principal and thread.
2. Run A requests handoff. The browser port revokes new agent commands and drains
   an in-flight command before enabling human input.
3. Run A emits `RUN_STARTED`, an `ACTIVITY_SNAPSHOT` showing human control, then
   `RUN_FINISHED` with an interrupt. This is a closed run, not a running SSE
   connection waiting for human input. The browser belongs to the host and
   remains available after the response ends.
4. Manual input uses a separate host control channel, checked against the owner,
   thread and current interrupt. It never uses AG-UI tool arguments or resume
   payloads to transport credentials.
5. Run B answers the interrupt with `status: "resolved"` and
   `payload: { action: "continue" }`. The host checks the current lease and
   browser state, revokes/drains human input, then checks expiry and readiness
   again. Only then does it read as the agent.
6. Updates reuse the Activity message ID. Run B ends with success and closes the
   demo browser. A cancelled answer instead ends with the cancelled outcome and
   closes the browser without continuing the agent action.

`example.browser-handoff` is an application-owned reason/activity type, not a
reserved or proposed standard value. Activity is a display projection; it does
not grant control. `BrowserControl` is the host boundary for this example only.
The answer communicates intent to continue, not proof of authentication or
completion of a real browser task.

The coordinator claims each transition before awaiting driver work. Missing,
unknown, duplicate, cross-owner, cross-thread, expired and reused-run requests
are rejected before changing ownership. Readiness probes and close acknowledgements
are awaited. A failed transition attempts cleanup and emits `RUN_ERROR`;
uncertain browser actions are not automatically retried. Unconfirmed cleanup
projects `control: "unknown"`, never a successful cancellation.
Expired interrupts can still be explicitly cancelled.

## Validation

```sh
pnpm exec nx run @ag-ui/client:test --excludeTaskDependencies -- prototypes/browser-handoff
pnpm exec tsc -p sdks/typescript/packages/client/prototypes/browser-handoff/tsconfig.json
pnpm --dir sdks/typescript/packages/client exec eslint prototypes/browser-handoff/*.ts
pnpm exec nx run @ag-ui/client:test --excludeTaskDependencies -- src prototypes/browser-handoff
```

Validated on upstream `c31e1e819e3a3c3b4af14add04f5b9a9a0208cae`, independently
of the SSE metadata prototype and EOF fix:

- 27 example tests, including four real loopback HTTP/SSE `HttpAgent` flows.
- Combined client source + example suite: 1,414 tests in 112 files passed.
- Client build, separate strict example typecheck, example lint and formatting.
- Standalone automatic-continuation and interactive cancellation demo paths.
- Mutation checks: tests fail when ownership checks, concurrent transition
  exclusion, post-drain readiness checks, cancellation handling, or agent-command
  draining are deliberately broken. Sources are restored after each check.

The tests exercise protocol event schemas and the actual client's lifecycle
verification, reducer, pending interrupts and Activity replacement. The host-only
cases cover races, stale input, expiry during handback and driver failures.

## Review and contribution scope

Self-review found and fixed a readiness race: checking only before draining
human input could continue after that input changed the page. Readiness and
expiry are now checked again after handback, with regression coverage.

This is suitable for discussion as a small executable recipe, with example
placement and a possible Dojo page to be agreed with maintainers. Existing
interrupts, resume entries and Activity messages express the flow; no SDK defect
or missing protocol primitive was established.

The boundary is intentional:

- The loopback server injects a fixed principal to model prior authentication;
  it is a test/demo transport, not a deployable authenticated browser service.
- The browser port must implement real driver mutual exclusion, draining and
  revocation. The workbench exercises real DOM input, queued asynchronous manual
  operations, and revocation of a cooperative page. Agent-operation draining is
  still exercised with a controlled promise. Navigation, cross-origin frames,
  real login readiness, and CDP/process shutdown remain untested.
- Browser resources and pending interrupts are in memory. Process restart,
  snapshot hydration, lost-response recovery and automatic reconnect are not
  implemented. Duplicate requests are rejected, not replayed idempotently.
- Expiry rejects control/continuation; it does not automatically dispose an idle
  resource. A real host needs resource TTL/cleanup and durable session policy.
- Host-owned sessions must not be destroyed merely because an SSE response
  finishes. Conversely, transport disconnect is not a user cancellation signal.
- Forced user takeover in the middle of an arbitrary running agent is outside
  this first example. The agent explicitly asks for the manual step.
- `close()` may reject. Success means input was revoked and accepted work drained;
  failure means cleanup is unconfirmed. The host must own a recovery/disposal
  policy for a real browser process. The test page can discard its own queued
  DOM write; this does not prove cancellation of an external request or side effect.

References: [interrupt/resume](https://docs.ag-ui.com/spec/1.0/basic/patterns/interrupt-resume),
[Activity](https://docs.ag-ui.com/spec/1.0/events/activity).

## Real-browser workbench and validation

```sh
pnpm exec tsx sdks/typescript/packages/client/prototypes/browser-handoff/browser-workbench.ts
# Open the printed loopback URL in Chrome. Stop with Ctrl-C after testing.
```

Use **New session** between cases. Sessions live until the test server stops.
The server checks Host and POST Origin and binds only to loopback; its fixed
principal and page driver are demo scaffolding, not production authentication.
The page driver is cooperative: revocation disables this page's controls, not
Chrome's native UI. There is no claim of arbitrary-site access enforcement.

Manually exercised with real Chrome clicks and observed DOM/AG-UI events on
2026-11-23 (no Playwright/CDP substitute for the browser):

| Case                                              | Observed result                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Request human control                             | Requesting run ends with interrupt; human buttons enabled; zero agent reads                                          |
| Return before completing step                     | HTTP 409; retains human control; a later completed step can succeed                                                  |
| Complete and return                               | One agent DOM read; success; input disabled; pending interrupts cleared                                              |
| Complete, start delayed input, immediately return | `transferring`, input disabled, zero reads while work pending; eventually one read and success                       |
| Start delayed input, immediately cancel           | `closing`, no cancellation success while work pending; then closed/cancelled; zero reads; one late DOM write blocked |
| Change page during handback                       | Second asynchronous readiness probe returns false; zero reads; cleanup and RUN_ERROR                                 |
| Fail close acknowledgement, cancel                | One close attempt; RUN_ERROR and unknown control; no false cancelled outcome; page can still be human-controlled     |
| Disconnect driver, cancel                         | Local page revokes input; server cannot confirm cleanup, reports unknown/RUN_ERROR; zero reads                       |

The real-browser adapter exposed assumptions not represented by the original
synchronous fixture:

1. Readiness is asynchronous. Both probes must be awaited, and the transition
   lock must be acquired **before** the first probe. Failed preflight leaves the
   run ID reusable, and the lock is released so cancellation remains possible.
2. Close is asynchronous and fallible. Await its acknowledgement before terminal
   success/cancellation. Do not retry an uncertain close or claim cleanup succeeded.
3. The real client retains a pending interrupt after RUN_ERROR. A UI must also
   consider host terminal failure, rather than enabling handback solely from the
   pending-interrupt list. This is recorded in a real HTTP client regression;
   it is not asserted to be a protocol or SDK bug.

Seven additional regression tests cover these boundaries. Re-running them against
the original coordinator produced six failures (one passed); restoring the fix
passed all 27 example tests and all 1,414 combined client/example tests. Strict
typechecking, example lint and formatting also pass. The changes remain
application-level recipe improvements; no protocol event or SDK API was added.
