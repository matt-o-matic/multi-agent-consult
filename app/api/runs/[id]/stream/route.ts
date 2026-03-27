import { runEventBus } from "@/lib/services/event-bus";

export const runtime = "nodejs";

function encodeSseEvent(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let interval: ReturnType<typeof setInterval> | undefined;

  function cleanup() {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    unsubscribe();
    unsubscribe = () => {};
  }

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          encodeSseEvent({
            type: "connected",
            runId: id,
            at: new Date().toISOString(),
          }),
        ),
      );

      unsubscribe = runEventBus.subscribe(id, (event) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
      });

      interval = setInterval(() => {
        controller.enqueue(
          encoder.encode(
            encodeSseEvent({
              type: "heartbeat",
              runId: id,
              at: new Date().toISOString(),
            }),
          ),
        );
      }, 15_000);

      request.signal.addEventListener(
        "abort",
        () => {
          cleanup();
          controller.close();
        },
        { once: true },
      );
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
