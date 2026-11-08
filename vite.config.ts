import { defineConfig, type Plugin } from "vite";

// Same clean URLs in dev as the Fastify server uses in production.
const PAGES: Record<string, string> = {
  "/": "/landing/index.html",
  "/en": "/landing/en/index.html",
  "/team": "/team.html",
  "/stage": "/timer.html",
  "/stage/demo": "/timer.html",
  "/admin/pult": "/pult.html",
  "/login": "/login.html",
  "/juror": "/juror.html",
  "/admin": "/admin.html",
  "/admin/setup": "/setup.html",
  "/admin/orgs": "/orgs.html",
  "/admin/qr": "/qr.html",
  "/admin/programs": "/programs.html",
  "/root": "/root.html",
  "/timer": "/timer.html",
  "/reveal": "/reveal.html",
  "/speaker": "/speaker.html",
};
const cleanUrls = (): Plugin => ({
  name: "clean-urls",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const url = (req.url ?? "").split("?")[0].replace(/\/$/, "") || "/";
      if (PAGES[url]) req.url = PAGES[url];
      else if (/^\/j\/[^/]+$/.test(url)) req.url = "/join.html";
      else if (/^\/t\/[^/]+$/.test(url)) req.url = "/team.html";
      else if (/^\/o\/[^/]+\/(timer|stage|reveal|speaker|team)$/.test(url)) req.url = PAGES[`/${url.split("/")[3]}`];
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
      "/vendor": { target: api },
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
        join: "web/join.html",
        speaker: "web/speaker.html",
        team: "web/team.html",
        pult: "web/pult.html",
        orgs: "web/orgs.html",
        root: "web/root.html",
        qr: "web/qr.html",
        programs: "web/programs.html",
      },
    },
  },
});
