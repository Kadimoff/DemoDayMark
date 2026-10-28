import { defineConfig, type Plugin } from "vite";

// Same clean URLs in dev as the Fastify server uses in production.
const PAGES: Record<string, string> = {
  "/": "/login.html",
  "/login": "/login.html",
  "/juror": "/juror.html",
  "/admin": "/admin.html",
  "/admin/setup": "/setup.html",
  "/timer": "/timer.html",
  "/reveal": "/reveal.html",
};
const cleanUrls = (): Plugin => ({
  name: "clean-urls",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const url = (req.url ?? "").split("?")[0].replace(/\/$/, "") || "/";
      if (PAGES[url]) req.url = PAGES[url];
      next();
    });
  },
});

const api = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  root: "web",
  publicDir: "../assets",
  plugins: [cleanUrls()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: api },
      "/socket.io": { target: api, ws: true },
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        login: "web/login.html",
        juror: "web/juror.html",
        admin: "web/admin.html",
        setup: "web/setup.html",
        timer: "web/timer.html",
        reveal: "web/reveal.html",
      },
    },
  },
});
