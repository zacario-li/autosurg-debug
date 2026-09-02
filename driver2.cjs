const Module = require("node:module");
const lines = [];
const chan = { clear: () => (lines.length = 0), show: () => {}, appendLine: (l) => lines.push(l), dispose: () => {} };
const vscodeStub = { window: { createOutputChannel: () => chan }, workspace: { getConfiguration: () => ({ get: (k, d) => d }) } };
const orig = Module._load;
Module._load = function (request, ...rest) { if (request === "vscode") return vscodeStub; return orig.call(this, request, ...rest); };
require("/tmp/lsb/bundle.cjs");
(async () => {
  const panel = new globalThis.LogStreamPanel();
  panel.open({ host: "127.0.0.1", port: 5599 });
  await new Promise((r) => setTimeout(r, 900));
  panel.dispose();
  const joined = lines.join("\n");
  const checks = {
    connected: joined.includes("[autosurg] connected"),
    backfillNote: joined.includes("2 recent entries"),
    ridFormatted: /rid=000042-ab12 live epoch/.test(joined),
    skipDashRid: / INFO\s+runtime\.system:run:42 backfill one/.test(joined),
    workerError: joined.includes("main/stereo"),
  };
  console.log("---- panel output ----\n" + joined);
  console.log("---- checks ----");
  let ok = true;
  for (const [k, v] of Object.entries(checks)) { console.log(k.padEnd(14), v ? "PASS" : "FAIL"); ok = ok && v; }
  process.exit(ok ? 0 : 1);
})();
