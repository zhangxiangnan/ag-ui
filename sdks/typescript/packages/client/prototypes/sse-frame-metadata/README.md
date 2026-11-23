# Opt-in SSE frame metadata prototype

Proposal for [AG-UI #2105](https://github.com/ag-ui-protocol/ag-ui/issues/2105).
This branch builds on the EOF boundary fix in [#3448](https://github.com/ag-ui-protocol/ag-ui/pull/3448)
(`24c742195805ff70d0e5365ab100359136ebf11b`), based on upstream main at
`c31e1e819e3a3c3b4af14add04f5b9a9a0208cae`.

## Problem and API

Custom transports currently need to parse the byte stream themselves to retain
SSE `id:` fields. This prototype exports an opt-in helper from `@ag-ui/client`:

```ts
interface SSEFrame {
  data?: string;
  id?: string;
}

// Observable<HttpEvent> -> Observable<SSEFrame>
parseSSEFrames(runHttpRequest(() => fetch(url, requestOptions)));
```

`data` is the joined raw payload, before JSON parsing. `id` is the last valid
explicit ID in this frame. An absent ID differs from `id: ""`; IDs are not
inherited from previous frames. ID-only frames are included. NUL-bearing ID
fields are ignored, and exactly one optional space after the colon is removed.

The helper emits only after the terminating blank line, discarding unfinished
tails at EOF. It accepts the existing AG-UI LF binding, not the complete SSE
CR/CRLF grammar. Comments, `event`, `retry`, and unknown fields are ignored.
Each subscription has independent decoding state, and cancellation propagates
to that subscription's source.

Delivery means a complete frame was received, **not** that its event was applied
or persisted. A custom transport must choose its cursor-acknowledgement policy,
including how to handle ID-only/reset frames and application failures. A frame
ID is not automatically safe or appropriate to send as an HTTP request header.

## Scope and compatibility

- No automatic reconnect, deduplication, sequence interpretation, replay store,
  `Last-Event-ID` request policy, or changes to `HttpAgent`/`BaseEvent`.
- The existing `parseSSEStream()` continues to output JSON and ignore metadata;
  its eager, single-source, multicast subscription behavior is preserved.
- Both readers share an internal LF frame splitter. Field decoding is separate:
  the new raw helper accepts bare `data` as empty data, while the old JSON reader
  retains its existing behavior of ignoring bare `data`.
- The existing 10 MiB decoded-character limit applies to the unterminated tail.
  It is not a completed-frame size cap or a bound on all temporary allocations.
- CR/CRLF support (#2939) and framing performance (#3328) remain separate work;
  moving the shared splitter would need coordination if those land first.

## Validation and review

Run from the repository root with the supported Node 22 toolchain:

```sh
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run @ag-ui/client:test --excludeTaskDependencies -- src
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run-many --targets=build,typecheck,lint --projects=@ag-ui/client --excludeTaskDependencies
```

- Client source suite: **1,416 tests in 113 files passed**, including 19 new cases.
- New cases cover every byte boundary, BOM/split UTF-8, empty/absent/repeated/NUL
  IDs, ID-only frames, incomplete EOF, source errors, independent subscriptions,
  synchronous cancellation, Response reader cancellation, the tail limit, and
  legacy JSON reader compatibility.
- Build, typecheck, lint, formatting, and ESM/CommonJS public-export smoke checks
  passed. The internal splitter is not exported from the package entry point.
- Manual mutation checks confirmed failures when dropping IDs, flushing partial
  EOF frames, dropping empty/ID-only frames, or breaking cancellation propagation.
- Self-review found no blocking issue within this LF-only primitive's scope.
  This suite does not establish end-to-end resumable transport semantics.

## Maintainer feedback sought

Would an opt-in transport helper with these semantics be useful as a small PR
while the resumable transport contract is discussed? In particular, is exposing
per-frame IDs (including ID-only frames) preferable to an EventSource-style
sticky `lastEventId`? API names are provisional. No feature PR has been opened.
