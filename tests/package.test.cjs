const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
const root = path.join(__dirname, "../extension");
test("MV3 manifest references existing local scripts without cookie/debugger privileges", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts.flatMap(s => s.js)]) assert.ok(fs.existsSync(path.join(root, file)), file);
  for (const permission of ["cookies", "debugger", "webRequest", "history", "tabs"]) assert.ok(!manifest.permissions.includes(permission));
  assert.ok(manifest.content_scripts.every(s => s.matches.every(pattern => pattern === "https://*.chaoxing.com/*")));
});
test("settings page contains accessible controls and only local executable resources", () => {
  const doc = new JSDOM(fs.readFileSync(path.join(root, "options.html"), "utf8")).window.document;
  for (const id of ["autoAnswer", "autoSubmit", "aiEnabled", "visionEnabled", "apiBase", "apiKey", "maxCalls", "confidence"]) assert.ok(doc.querySelector(`label input#${id}, label textarea#${id}`), id);
  assert.equal(doc.querySelector("#bank"), null);
  const bank = new JSDOM(fs.readFileSync(path.join(root, "bank.html"), "utf8")).window.document;
  assert.ok(bank.querySelector("#bank"));
  assert.equal(bank.querySelector("#apiKey"), null);
  assert.equal(doc.querySelector("#maxCalls").max, "10000");
  assert.equal(doc.querySelector("#apiKey").type, "password");
  assert.ok([...doc.querySelectorAll("script")].every(el => el.src && !el.src.includes("://")));
  assert.equal(doc.querySelector("[onclick]"), null);
});
