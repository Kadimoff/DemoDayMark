// The deploy platform (Coolify) passes runtime env vars into the Docker build too, so `npm test` inside the
// image build would see e.g. BOOTSTRAP_* and create extra accounts in test databases. Tests must only use
// the env they set themselves.
for (const k of Object.keys(process.env)) {
  if (/^(BOOTSTRAP_|ADMIN_|SESSION_SECRET$|BACKUP_|ORIGIN$|DATA_DIR$|SHOW_JUROR_TOTAL$|MIN_JURORS_FOR_RANK$|TRUST_PROXY$|COOKIE_SECURE$|IMPORT_ARCHIVE_)/.test(k)) delete process.env[k];
}
// v11: no periodic backups in tests unless a test turns them on itself (loadConfig overrides).
process.env.BACKUP_INTERVAL_MIN = "0";
// A build that injects NODE_ENV=production must not turn tests into production config (SESSION_SECRET check, secure cookies).
process.env.NODE_ENV = "test";
