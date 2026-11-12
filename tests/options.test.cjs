const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
const C = require("../extension/core.js");
test("restored clear-key checkbox resets and conflicting new key never reaches Save", async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../extension/options.html"), "utf8"), {runScripts: "outside-only"});
  const win = dom.window;
  const requests = [];
  win.document.querySelector("#clearKey").checked = true;
  win.CourseCore = C;
  win.chrome = {runtime: {sendMessage: async message => {
    requests.push(message.type);
    return message.type === "getSettings" ? {...C.defaults, hasKey: true} : {ok: true};
  }}, permissions: {request: async () => true}};
  win.eval(fs.readFileSync(path.join(__dirname, "../extension/options.js"), "utf8"));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(win.document.querySelector("#clearKey").checked, false);
  win.document.querySelector("#apiKey").value = "new-unit-key";
  win.document.querySelector("#clearKey").checked = true;
  await win.document.querySelector("form").onsubmit({preventDefault() {}});
  assert.equal(requests.includes("saveSettings"), false);
  assert.match(win.document.querySelector("#message").textContent, /不能同时/);
  dom.window.close();
});
