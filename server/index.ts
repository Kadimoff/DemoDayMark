import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const { app, close } = await buildApp(cfg, { logger: true });

await app.listen({ port: cfg.port, host: cfg.host });
console.log(`munsif.im hazırdır: http://localhost:${cfg.port}  (səhnə: /stage · taymer: /timer)`);

// v11: every state that matters (scores, stage, timer, reveal) is in SQLite, so a crash loses nothing that was answered
// as saved. A stray rejected promise is logged and the server keeps serving; an uncaught exception leaves the process in
// an unknown state, so it is logged and the process exits (Docker / Coolify start it again, clients reconnect by themselves).
process.on("unhandledRejection", err => { app.log.error({ err }, "unhandled promise rejection"); });
process.on("uncaughtException", err => {
  app.log.fatal({ err }, "uncaught exception — exiting so the container restarts");
  setTimeout(() => process.exit(1), 3000).unref();
  void close().finally(() => process.exit(1));
});

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    app.log.warn(`${sig} received, shutting down`);
    // never hang a redeploy: hard exit if a connection keeps the close from finishing
    setTimeout(() => process.exit(0), 8000).unref();
    try { await close(); } catch (err) { app.log.error({ err }, "error while shutting down"); }
    process.exit(0);
  });
}
