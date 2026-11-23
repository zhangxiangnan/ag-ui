import { filter, map, Observable, Subscriber } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";

/** Maximum unterminated tail, counted in decoded characters (not bytes). */
export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/** A complete LF-delimited frame, not an EventSource-dispatched event. */
export interface SSEFrame {
  /** Joined data fields, without JSON decoding; absent when there was no data field. */
  data?: string;
  /** Last valid explicit id in THIS frame; absent differs from an empty/reset id. */
  id?: string;
}

/**
 * Opt-in framing primitive for custom transports. Accepts the AG-UI LF binding,
 * not the full SSE CR/CRLF grammar. Each subscription owns its decoder and buffer
 * and unsubscribing releases that subscription to the source.
 *
 * Emits data-bearing or id-only frames once their blank line arrives. Comments,
 * event/retry fields and unknown fields are ignored. IDs are NOT inherited across
 * frames, interpreted as sequence numbers, or acknowledged as applied state.
 * No replay, deduplication, reconnect, or Last-Event-ID request policy is implied.
 */
export function parseSSEFrames(source$: Observable<HttpEvent>): Observable<SSEFrame> {
  return readSSEFrames(source$).pipe(
    map((text): SSEFrame | undefined => {
      const frame: SSEFrame = {};
      const data: string[] = [];
      for (const line of text.split("\n")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        if (field === "id" && !value.includes("\0")) frame.id = value;
      }
      if (data.length) frame.data = data.join("\n");
      return frame.data !== undefined || frame.id !== undefined ? frame : undefined;
    }),
    filter((frame): frame is SSEFrame => frame !== undefined),
  );
}

/** @internal Shared framing; the legacy JSON reader keeps its own field semantics. */
export function readSSEFrames(source$: Observable<HttpEvent>): Observable<string> {
  return new Observable((subscriber) => {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let buffer = "";
    const upstream = new Subscriber<HttpEvent>({
      next(event: HttpEvent) {
        if (event.type !== HttpEventType.DATA || !event.data) return;
        buffer += decoder.decode(event.data, { stream: true });
        const frames = buffer.split(/\n\n/);
        buffer = frames.pop() || "";
        for (const frame of frames) {
          if (subscriber.closed) return;
          subscriber.next(frame);
        }
        // Preserve the existing guard: measure only the unterminated tail, not
        // a read carrying several completed frames. This is not a frame-size cap.
        if (!subscriber.closed && buffer.length > MAX_BUFFER_SIZE) {
          subscriber.error(
            new Error(
              `SSE buffer size exceeded maximum limit of ${MAX_BUFFER_SIZE / (1024 * 1024)} MB`,
            ),
          );
        }
      },
      error: (error: unknown) => subscriber.error(error),
      complete: () => subscriber.complete(), // EOF never dispatches a partial frame.
    });
    // Attach before subscribing: even synchronous sources must stop when a
    // downstream take(1) or a buffer error closes the subscription.
    subscriber.add(upstream);
    subscriber.add(() => {
      buffer = "";
    });
    source$.subscribe(upstream);
  });
}
