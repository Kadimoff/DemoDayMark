import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const { app, close } = await buildApp(cfg, { logger: true });

await app.listen({ port: cfg.port, host: cfg.host });
console.log(`munsif.im hazırdır: http://localhost:${cfg.port}  (səhnə: /stage · taymer: /timer)`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    await close();
    process.exit(0);
  });
}
