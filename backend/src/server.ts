import http from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { pool } from "./db";
import { closeIo, initSockets } from "./sockets";

const app = createApp();
const server = http.createServer(app);
initSockets(server);
server.listen(env.PORT, () => console.log(`CAFE-OS API listening on :${env.PORT} (${env.NODE_ENV}, payments: ${env.PAYMENT_TEST_MODE ? "TEST MODE" : "live"})`));
let closing = false;
const shutdown = async (sig: string) => {
  if (closing) return; closing = true; console.log(`${sig} received, shutting down`);
  const t = setTimeout(() => process.exit(1), 10_000); t.unref();
  await closeIo(); server.close(async () => { await pool.end(); process.exit(0); });
};
process.on("SIGTERM", () => shutdown("SIGTERM")); process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
