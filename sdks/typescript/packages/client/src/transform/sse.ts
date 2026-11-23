import { Observable, Subject } from "rxjs";
import { HttpEvent } from "../run/http-request";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";
import { readSSEFrames } from "./sse-frames";

/**
 * Maximum size the framing buffer is allowed to reach before the stream fails.
 *
 * The buffer holds the tail after the last \n\n, so a response that never sends a
 * boundary grows it to the size of the whole response. Mirrors
 * SseParser::kMaxBufferSize in the C++ SDK
 * (sdks/community/c++/src/stream/sse_parser.h), which caps the same
 * accumulation at 10 MB.
 *
 * Counted in decoded characters rather than bytes, because the buffer is
 * already a string at the point of the check.
 */
export { MAX_BUFFER_SIZE } from "./sse-frames";

/**
 * Parses a stream of HTTP events into a stream of JSON objects using Server-Sent Events (SSE) format.
 * Strictly follows the SSE standard where:
 * - Events are separated by double newlines ('\n\n')
 * - Only 'data:' prefixed lines are processed
 * - Multi-line data events are supported and joined
 * - Non-data fields (event, id, retry) are ignored
 */
export const parseSSEStream = (
  source$: Observable<HttpEvent>,
  debugLogger?: DebugLoggerInput,
  // DEFERRED (PNI-272): this is the exported stream element type; changing it
  // to `unknown` ripples into every consumer of parseSSEStream.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Observable<any> => {
  const log = resolveDebugLogger(debugLogger);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the exported Observable<any> above
  const jsonSubject = new Subject<any>();
  // Subscribe to the source once and multicast to all subscribers
  readSSEFrames(source$).subscribe({
    next: processSSEEvent,
    error: (err) => jsonSubject.error(err),
    complete: () => jsonSubject.complete(),
  });

  /**
   * Helper function to process an SSE event.
   * Extracts and joins data lines, then parses the result as JSON.
   *
   * Follows the SSE spec by processing lines starting with 'data:',
   * ignoring a single space if it is present after the colon.
   *
   * @param eventText The raw event text to process
   */
  function processSSEEvent(eventText: string) {
    const lines = eventText.split("\n");
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data:")) {
        // Remove 'data:' prefix, and optionally a single space afterwards
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }

    // Only process if we have data lines
    if (dataLines.length > 0) {
      try {
        // Join multi-line data and parse JSON
        const jsonStr = dataLines.join("\n");
        const json = JSON.parse(jsonStr);
        // `json` is whatever the frame held — `null` and primitives included,
        // so the type is read defensively: a throw here would surface as an
        // unhandled host error rather than as a stream failure.
        log?.event("SSE", "Event received:", json, {
          type: (json as { type?: unknown } | null)?.type,
        });
        jsonSubject.next(json);
      } catch (err) {
        jsonSubject.error(err);
      }
    }
  }

  return jsonSubject.asObservable();
};
