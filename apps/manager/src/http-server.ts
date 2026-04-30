// Minimal HTTP server so the Control Plane can push thread-notify messages
// to the Manager without polling. Listens on MANAGER_HTTP_PORT (default 3001).
//
// Endpoints:
//   POST /forward-notify  { threadRef, message } → posts via ThreadPoster
//   GET  /healthz          → { ok: true }

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pino from "pino";
import type { ThreadPoster } from "./thread-poster";

const log = pino({ name: "http-server" });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function startHttpServer(poster: ThreadPoster, internalToken: string): void {
  const port = Number(process.env.MANAGER_HTTP_PORT ?? 3001);

  const server = createServer(async (req, res) => {
    // Auth gate: same X-Internal-Token the CP uses everywhere.
    const tok = req.headers["x-internal-token"];
    if (tok !== internalToken) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && req.url === "/healthz") {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/forward-notify") {
      try {
        const body = await readBody(req);
        const { threadRef, message } = JSON.parse(body) as { threadRef: string; message: string };
        if (!threadRef || !message) {
          json(res, 400, { error: "threadRef and message required" });
          return;
        }
        await poster.post(threadRef as never, message);
        json(res, 200, { ok: true });
      } catch (err) {
        log.error({ err: (err as Error).message }, "forward-notify failed");
        json(res, 500, { error: (err as Error).message });
      }
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  server.listen(port, () => {
    log.info({ port }, "manager HTTP server listening");
  });

  server.on("error", (err) => {
    log.error({ err: err.message }, "manager HTTP server error");
  });
}
