const {test} = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const {webcrypto} = require("node:crypto");
const C = require("../extension/core.js");
const url = "https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=42&clazzid=9&chapterId=1";
const owner = {url: "chrome-extension://unit/options.html"};
const site = {url: "https://mooc1.chaoxing.com/work/doHomeWorkNew", tab: {id: 1}, frameId: 2};
function harness(config = {}, fetcher = async () => { throw new Error("Unexpected network request"); }) {
  const data = {local: {settings: {...C.defaults, ...config}}, session: {}};
  let listener;
  const store = area => ({
    get: async key => structuredClone({[key]: data[area][key]}),
    set: async items => Object.assign(data[area], structuredClone(items)),
    remove: async key => { delete data[area][key]; },
    setAccessLevel: async value => { data.access = value; }
  });
  const tab = {id: 1, url};
  const chrome = {
    storage: {local: store("local"), session: store("session")},
    permissions: {contains: async () => true},
    tabs: {get: async () => ({...tab}), sendMessage: async () => ({ready: true}), onRemoved: {addListener() {}}},
    runtime: {getURL: suffix => "chrome-extension://unit/" + suffix, onMessage: {addListener(fn) { listener = fn; }}}
  };
  const context = vm.createContext({chrome, CourseCore: C, importScripts() {}, crypto: webcrypto, URL, Date, setTimeout, clearTimeout, AbortController, fetch: fetcher});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8"), context);
  return {data, tab, send: (message, sender = owner) => new Promise(resolve => listener(message, sender, resolve)), start: async function () { await this.send({type: "start", tabId: 1}); return this.data.session.run; }};
}
const question = {title: "选偶数", type: "single", options: [{text: "1"}, {text: "2"}]};
const solveMessage = run => ({type: "solve", token: run.token, chapter: run.chapter, question});
test("bank lookup uses no network and responses never contain an API key", async () => {
  const h = harness({apiKey: "private-test-key", bank: [{question: "选偶数", answer: ["2"]}]});
  const run = await h.start();
  const result = await h.send(solveMessage(run), site);
  assert.deepEqual(result.indexes, [1]);
  assert.equal(h.data.access.accessLevel, "TRUSTED_CONTEXTS");
  const state = await h.send({type: "state"}, site);
  const config = await h.send({type: "getSettings"});
  assert.equal(config.hasKey, true);
  assert.equal(config.apiKey, "");
  assert.ok(!JSON.stringify([result, state, h.data.session]).includes("private-test-key"));
  assert.equal((await h.send({type: "getSettings"}, site)).apiKey, undefined);
});
test("AI request is sent only to configured endpoint and validates full-option answers", async () => {
  let request;
  const h = harness({aiEnabled: true, apiKey: "unit-key", apiBase: "https://api.example.test/v1", model: "unit-model"}, async (endpoint, init) => {
    request = {endpoint, init};
    return {ok: true, json: async () => ({choices: [{message: {content: '```json\n{"answers":["2"],"confidence":0.95}\n```'}}]})};
  });
  const run = await h.start();
  const result = await h.send(solveMessage(run), site);
  assert.deepEqual(Array.from(result.indexes), [1]);
  assert.equal(request.endpoint, "https://api.example.test/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer unit-key");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.credentials, "omit");
  assert.ok(!request.init.body.includes("unit-key"));
  assert.equal(h.data.session.run.calls, 1);
});
test("stop is not blocked by an outstanding AI call and late results are discarded", async () => {
  let finish, called;
  const entered = new Promise(resolve => { called = resolve; });
  const h = harness({aiEnabled: true, apiBase: "https://api.example.test/v1", model: "unit"}, async () => {
    called();
    return await new Promise(resolve => { finish = resolve; });
  });
  const run = await h.start();
  const answering = h.send(solveMessage(run), site);
  await entered;
  const stopped = await h.send({type: "stop"});
  assert.equal(stopped.phase, "stopped");
  finish({ok: true, json: async () => ({choices: [{message: {content: '{"answers":["2"],"confidence":1}'}}]})});
  assert.match((await answering).error, /停止/);
});
test("course changes pause execution; chapter changes clear reports", async () => {
  const h = harness();
  let run = await h.start();
  await h.send({type: "report", token: run.token, chapter: run.chapter, hasTask: true, done: true}, site);
  h.tab.url = url.replace("chapterId=1", "chapterId=2");
  const state = await h.send({type: "state"}, site);
  assert.equal(state.chapter, "2");
  assert.deepEqual(h.data.session.run.frames, {});
  h.tab.url = url.replace("courseId=42", "courseId=43");
  assert.equal((await h.send({type: "state"}, site)).phase, "paused");
});
test("untrusted messages and missing answers cannot access settings or call AI", async () => {
  const h = harness();
  const run = await h.start();
  assert.match((await h.send({type: "getSettings"}, {url: "https://evil.test/", tab: {id: 1}})).error, /来源/);
  assert.match((await h.send(solveMessage(run), site)).error, /未命中/);
  assert.equal(h.data.session.run.calls, 0);
});
test("AI errors, invalid output, low confidence and budget exhaustion stop answer return", async () => {
  for (const response of [
    {ok: false, status: 401},
    {ok: true, json: async () => ({choices: [{message: {content: "not json"}}]})},
    {ok: true, json: async () => ({choices: [{message: {content: '{"answers":["2"],"confidence":0.4}'}}]})},
    {ok: true, json: async () => ({choices: [{message: {content: '{"answers":["unknown"],"confidence":1}'}}]})}
  ]) {
    const h = harness({aiEnabled: true, apiBase: "https://api.example.test/v1", model: "unit", maxCalls: 1}, async () => response);
    const run = await h.start();
    assert.ok((await h.send(solveMessage(run), site)).error);
    assert.match((await h.send(solveMessage(run), site)).error, /上限/);
  }
});
test("concurrent frame reports are not lost and settings changes pause execution", async () => {
  const h = harness({apiKey: "saved-key"});
  const run = await h.start();
  await Promise.all([2, 3, 4].map(frameId => h.send({type: "report", token: run.token, chapter: run.chapter, hasTask: true, done: false}, {...site, frameId})));
  assert.equal(Object.keys(h.data.session.run.frames).length, 3);
  await h.send({type: "saveSettings", settings: {...C.defaults, apiKey: ""}});
  assert.equal(h.data.local.settings.apiKey, "saved-key");
  assert.equal(h.data.session.run.phase, "paused");
  await h.send({type: "saveSettings", settings: {...C.defaults, apiKey: ""}, clearKey: true});
  assert.equal(h.data.local.settings.apiKey, "");
});
test("vision requires opt-in and sends only question image in the multimodal request", async () => {
  const image = "data:image/png;base64,dGVzdA==";
  const visual = {...question, options: [{text: "乱码1", label: "A"}, {text: "乱码2", label: "B"}]};
  const off = harness({aiEnabled: true, apiBase: "https://api.example.test/v1", model: "unit"});
  const first = await off.start();
  assert.match((await off.send({...solveMessage(first), question: visual, image}, site)).error, /尚未启用/);
  let body;
  const on = harness({aiEnabled: true, visionEnabled: true, apiBase: "https://api.example.test/v1", model: "vision"}, async (_, init) => {
    body = JSON.parse(init.body);
    return {ok: true, json: async () => ({choices: [{message: {content: '{"labels":["B"],"confidence":0.95}'}}]})};
  });
  const run = await on.start();
  const result = await on.send({...solveMessage(run), question: visual, image}, site);
  assert.deepEqual(Array.from(result.indexes), [1]);
  assert.equal(result.visual, true);
  assert.equal(body.messages[1].content[1].image_url.url, image);
});
test("saving a new key and deleting it together is rejected without changing stored settings", async () => {
  const h = harness({apiKey: "existing-test-key"});
  const result = await h.send({type: "saveSettings", settings: {...C.defaults, apiKey: "new-test-key"}, clearKey: true});
  assert.match(result.error, /不能同时/);
  assert.equal(h.data.local.settings.apiKey, "existing-test-key");
});
test("AI and bank page saves preserve each other's settings and allow larger call budgets", async () => {
  const h = harness({apiKey: "stored-unit-key", bank: [{question: "原题", answer: ["答案"]}], aiEnabled: true, apiBase: "https://api.example.test/v1", model: "unit"});
  let result = await h.send({type: "saveSettings", settings: {maxCalls: 10000, model: "updated-model"}});
  assert.equal(result.ok, true);
  assert.equal(h.data.local.settings.maxCalls, 10000);
  assert.equal(h.data.local.settings.bank[0].question, "原题");
  result = await h.send({type: "saveSettings", settings: {bank: [{question: "新题", answer: ["新答案"]}]}});
  assert.equal(result.ok, true);
  assert.equal(h.data.local.settings.apiKey, "stored-unit-key");
  assert.equal(h.data.local.settings.model, "updated-model");
  assert.equal(h.data.local.settings.maxCalls, 10000);
  await h.start();
  assert.equal((await h.send({type: "overview"})).limit, 10000);
});
test("departing old iframe cannot erase a replacement document's report", async () => {
  const h = harness();
  const run = await h.start();
  await h.send({type: "report", token: run.token, chapter: run.chapter, hasTask: true, done: false, docKey: "old"}, site);
  await h.send({type: "report", token: run.token, chapter: run.chapter, hasTask: true, done: true, docKey: "new"}, site);
  await h.send({type: "depart", token: run.token, chapter: run.chapter, docKey: "old"}, site);
  assert.equal(h.data.session.run.frames[2].docKey, "new");
  await h.send({type: "depart", token: run.token, chapter: run.chapter, docKey: "new"}, site);
  assert.equal(h.data.session.run.frames[2], undefined);
});
test("fresh settings use the requested default of 1000 calls", async () => {
  const h = harness();
  assert.equal((await h.send({type: "getSettings"})).maxCalls, 1000);
  await h.start();
  assert.equal((await h.send({type: "overview"})).limit, 1000);
});
