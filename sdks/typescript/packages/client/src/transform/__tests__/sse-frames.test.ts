import { firstValueFrom, Observable, of, Subject, take, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { parseSSEFrames, type SSEFrame } from "../index";
import { MAX_BUFFER_SIZE, parseSSEStream } from "../sse";
import { HttpEvent, HttpEventType, runHttpRequest } from "../../run/http-request";

const data = (text: string): HttpEvent => ({
  type: HttpEventType.DATA,
  data: new TextEncoder().encode(text),
});
const parse = (text: string) => firstValueFrom(parseSSEFrames(of(data(text))).pipe(toArray()));

describe("opt-in SSE frame metadata", () => {
  it("pairs each id with its complete, unparsed data and joins multiline data", async () => {
    expect(await parse('id: run:9\ndata: {\ndata: "delta":"你好🌍"}\n\n')).toEqual([
      { id: "run:9", data: '{\n"delta":"你好🌍"}' },
    ]);
    expect(await parse("data: not JSON\nid: opaque:10\n\n")).toEqual([
      { data: "not JSON", id: "opaque:10" },
    ]);
  });

  it("distinguishes absent, empty, id-only, and non-inherited IDs", async () => {
    expect(await parse("id: a\ndata: one\n\ndata: two\n\nid:\n\nid\n\ndata:\n\ndata\n\n")).toEqual([
      { id: "a", data: "one" },
      { data: "two" },
      { id: "" },
      { id: "" },
      { data: "" },
      { data: "" },
    ]);
  });

  it("keeps the last valid id field and ignores NUL-bearing IDs", async () => {
    expect(
      await parse("id: a\nid: b\nid: bad\0id\ndata: one\n\nid: bad\0\ndata: two\n\nid: a\nid:\n\n"),
    ).toEqual([{ id: "b", data: "one" }, { data: "two" }, { id: "" }]);
  });

  it("removes exactly one optional space and treats names as case-sensitive", async () => {
    expect(await parse("ID: ignored\nid:  opaque \ndata:\tvalue \n\n")).toEqual([
      { id: " opaque ", data: "\tvalue " },
    ]);
  });

  it("ignores comments, unknown fields, event/retry fields, and empty frames", async () => {
    expect(
      await parse("\n\n: keepalive\nretry: 1\nevent: other\nunknown: value\n\nid: bad\0\n\n"),
    ).toEqual([]);
  });

  it("preserves duplicate frames without inferring sequence or deduplicating", async () => {
    expect(await parse("id: z\ndata: one\n\nid: z\ndata: two\n\nid: a\ndata: three\n\n")).toEqual([
      { id: "z", data: "one" },
      { id: "z", data: "two" },
      { id: "a", data: "three" },
    ]);
  });

  it("works at every byte boundary, including a BOM, UTF-8, id, and the blank line", async () => {
    const bytes = new TextEncoder().encode(
      "\uFEFFid: 游标🌍\ndata: 你好🌍\n\nid: next\ndata: two\n\n",
    );
    const expected = [
      { id: "游标🌍", data: "你好🌍" },
      { id: "next", data: "two" },
    ];
    for (let split = 0; split <= bytes.length; split++) {
      const chunks: HttpEvent[] = [bytes.slice(0, split), bytes.slice(split)].map((data) => ({
        type: HttpEventType.DATA,
        data,
      }));
      expect(
        await firstValueFrom(parseSSEFrames(of(...chunks)).pipe(toArray())),
        `split ${split}`,
      ).toEqual(expected);
    }
    const chunks: HttpEvent[] = [...bytes].map((byte) => ({
      type: HttpEventType.DATA,
      data: Uint8Array.of(byte),
    }));
    expect(await firstValueFrom(parseSSEFrames(of(...chunks)).pipe(toArray()))).toEqual(expected);
  });

  it.each(["", "\n"])(
    "does not publish an id or JSON-complete tail before its blank line (%j)",
    async (suffix) => {
      expect(
        await parse(`id: acknowledged\ndata: first\n\nid: pending\ndata: {}${suffix}`),
      ).toEqual([{ id: "acknowledged", data: "first" }]);
    },
  );

  it("does not publish id-only or partially decoded tails at EOF", async () => {
    expect(await parse("id: pending\n")).toEqual([]);
    const bytes = new TextEncoder().encode("id: pending\ndata: 🌍");
    expect(
      await firstValueFrom(
        parseSSEFrames(of({ type: HttpEventType.DATA, data: bytes.slice(0, -1) })).pipe(toArray()),
      ),
    ).toEqual([]);
  });

  it("waits for the delimiter instead of treating an id as an early acknowledgement", () => {
    const source = new Subject<HttpEvent>();
    const frames: SSEFrame[] = [];
    parseSSEFrames(source).subscribe((frame) => frames.push(frame));
    source.next(data("id: next\ndata: {}\n"));
    expect(frames).toEqual([]);
    source.next(data("\n"));
    expect(frames).toEqual([{ id: "next", data: "{}" }]);
    source.complete();
  });

  it("keeps source errors intact and retains previously delivered frames", () => {
    const source = new Subject<HttpEvent>();
    const frames: SSEFrame[] = [];
    const error = vi.fn();
    parseSSEFrames(source).subscribe({ next: (frame) => frames.push(frame), error });
    source.next(data("id: one\ndata: ok\n\nid: partial\n"));
    const failure = new Error("connection reset");
    source.error(failure);
    expect(frames).toEqual([{ id: "one", data: "ok" }]);
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("is lazy and owns independent state on every subscription", async () => {
    let subscriptions = 0;
    const source = new Observable<HttpEvent>((subscriber) => {
      subscriptions++;
      subscriber.next(data("id: first\ndata: value\n\nid: partial"));
      subscriber.complete();
    });
    const frames = parseSSEFrames(source);
    expect(subscriptions).toBe(0);
    expect(await firstValueFrom(frames.pipe(toArray()))).toEqual([{ id: "first", data: "value" }]);
    expect(await firstValueFrom(frames.pipe(toArray()))).toEqual([{ id: "first", data: "value" }]);
    expect(subscriptions).toBe(2);
  });

  it("propagates synchronous take(1) cancellation to its source exactly once", async () => {
    const teardown = vi.fn();
    let reads = 0;
    const source = new Observable<HttpEvent>((subscriber) => {
      while (!subscriber.closed && reads < 3) {
        reads++;
        subscriber.next(data(`id: ${reads}\ndata: value\n\n`));
      }
      return teardown;
    });
    expect(await firstValueFrom(parseSSEFrames(source).pipe(take(1)))).toEqual({
      id: "1",
      data: "value",
    });
    expect(reads).toBe(1);
    expect(teardown).toHaveBeenCalledOnce();
  });

  it("does not share an in-flight frame between simultaneous subscribers", () => {
    const source = new Subject<HttpEvent>();
    const stream = parseSSEFrames(source);
    const first: SSEFrame[] = [];
    const second: SSEFrame[] = [];
    const firstSubscription = stream.subscribe((frame) => first.push(frame));
    source.next(data("id: first\ndata: part"));
    stream.subscribe((frame) => second.push(frame));
    source.next(data("ial\n\n"));
    expect(first).toEqual([{ id: "first", data: "partial" }]);
    expect(second).toEqual([]);
    firstSubscription.unsubscribe();
    source.next(data("id: second\ndata: complete\n\n"));
    source.complete();
    expect(first).toHaveLength(1);
    expect(second).toEqual([{ id: "second", data: "complete" }]);
  });

  it("releases a real Response reader when its consumer unsubscribes", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("id: one\ndata: value\n\n"));
        },
        cancel,
      }),
    );
    expect(await firstValueFrom(parseSSEFrames(runHttpRequest(async () => response)))).toEqual({
      id: "one",
      data: "value",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds the unterminated tail and stops a synchronous producer", () => {
    const teardown = vi.fn();
    const error = vi.fn();
    let wasClosed = false;
    const source = new Observable<HttpEvent>((subscriber) => {
      subscriber.next(data("x".repeat(MAX_BUFFER_SIZE + 1)));
      wasClosed = subscriber.closed;
      return teardown;
    });
    parseSSEFrames(source).subscribe({ error });
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0][0])).toContain("SSE buffer size exceeded");
    expect(wasClosed).toBe(true);
    expect(teardown).toHaveBeenCalledOnce();
  });

  it("keeps the JSON entry point's metadata-ignoring, eager multicast behavior", () => {
    const source = new Subject<HttpEvent>();
    const stream = parseSSEStream(source);
    source.next(data('id: missed\ndata: {"value":0}\n\n'));
    const first: unknown[] = [];
    const second: unknown[] = [];
    stream.subscribe((event) => first.push(event));
    stream.subscribe((event) => second.push(event));
    source.next(data('id: reset\n\nid:\ndata: {"value":1}\n\n'));
    source.complete();
    expect(first).toEqual([{ value: 1 }]);
    expect(second).toEqual(first);
  });

  it("keeps bare-data handling in the legacy reader while exposing it as raw data", async () => {
    expect(await parse("data\n\n")).toEqual([{ data: "" }]);
    const source = new Subject<HttpEvent>();
    const next = vi.fn();
    const error = vi.fn();
    parseSSEStream(source).subscribe({ next, error });
    source.next(data('data\ndata: {"value":1}\n\ndata\n\n'));
    source.complete();
    expect(next).toHaveBeenCalledExactlyOnceWith({ value: 1 });
    expect(error).not.toHaveBeenCalled();
  });
});
