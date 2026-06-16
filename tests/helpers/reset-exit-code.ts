// Preload retained for documentation; bun does not emit 'beforeExit' reliably,
// so exitCode isolation is handled per-file (each file that touches exitCode
// resets it to 0 in afterEach — bun ignores `= undefined`).
process.on('beforeExit', () => {
  process.exitCode = 0;
});
