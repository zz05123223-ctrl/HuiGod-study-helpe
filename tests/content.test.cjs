const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
const url = "https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=42&clazzid=9&chapterId=1";
const fixture = '<div class="TiMu"><div class="Zy_TItle">【单选题】选偶数</div><label><input type="radio" name="q">1</label><label><input type="radio" name="q">2</label></div>';
async function harness(html, solve = async () => ({indexes: [1], source: "模拟题库", token: "run", chapter: "1"}), configure = () => {}) {
  const dom = new JSDOM(html, {url, runScripts: "outside-only"});
  const win = dom.window;
  const clock = {now: 100000};
  win.Date.now = () => clock.now;
  win.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  let tick;
  win.setInterval = fn => { tick = fn; return 1; };
  win.setTimeout = (fn, delay) => { if (delay === 600) fn(); return 1; };
  const state = {phase: "running", token: "run", chapter: "1", note: "test", advance: false, options: {muted: true, autoAnswer: true, autoSubmit: true, autoNext: true}};
  const messages = [];
  win.chrome = {runtime: {onMessage: {addListener() {}}, sendMessage: async message => {
    messages.push(message);
    if (message.type === "state") return structuredClone(state);
    if (message.type === "solve") return await solve(message);
    if (message.type === "pause") { state.phase = "paused"; state.note = message.note; }
    return {ok: true};
  }}};
  const media = [...win.document.querySelectorAll("video")].map(video => {
    const data = {paused: true, ended: false, plays: 0, pauses: 0};
    Object.defineProperty(video, "paused", {get: () => data.paused});
    Object.defineProperty(video, "ended", {get: () => data.ended});
    video.play = async () => { data.plays++; data.paused = false; };
    video.pause = () => { data.pauses++; data.paused = true; };
    return {video, data};
  });
  configure({win, state, media});
  win.eval(fs.readFileSync(path.join(__dirname, "../extension/core.js"), "utf8"));
  win.eval(fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8"));
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  await flush();
  return {win, state, messages, media, clock, tick: async () => { await tick(); await flush(); }, flush, close: () => win.close()};
}
test("video plays at 1x, reports natural ending and stops owned playback", async () => {
  const h = await harness("<video></video>");
  const {video, data} = h.media[0];
  assert.equal(data.plays, 1);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.muted, true);
  assert.equal(h.messages.filter(x => x.type === "report").at(-1).done, false);
  data.ended = true;
  await h.tick();
  assert.equal(h.messages.filter(x => x.type === "report").at(-1).done, true);
  h.state.phase = "stopped";
  await h.tick();
  assert.equal(data.pauses, 1);
  h.close();
});
test("choice fill, submission confirmation, result and next chapter form one flow", async () => {
  const h = await harness(fixture + '<button id="submit">提交</button><button id="popok" hidden>确认提交</button><a id="next">下一节</a>');
  const doc = h.win.document;
  assert.equal(doc.querySelectorAll("input")[1].checked, true);
  let submits = 0, confirms = 0, advances = 0;
  doc.querySelector("#submit").onclick = () => { submits++; doc.querySelector("#popok").hidden = false; };
  doc.querySelector("#popok").onclick = () => { confirms++; doc.body.insertAdjacentHTML("beforeend", '<div class="work-result">已提交</div>'); };
  doc.querySelector("#next").onclick = () => { advances++; };
  await h.tick();
  assert.equal(submits, 1);
  await h.tick();
  assert.equal(confirms, 1);
  await h.tick();
  assert.equal(h.messages.filter(x => x.type === "report").at(-1).done, true);
  h.state.advance = true;
  await h.tick();
  assert.equal(advances, 1);
  assert.equal(h.messages.filter(x => x.type === "solve").length, 1);
  h.close();
});
test("stop during answer generation prevents late DOM modification", async () => {
  let answer;
  const h = await harness(fixture, () => new Promise(resolve => { answer = resolve; }));
  assert.equal(typeof answer, "function");
  h.state.phase = "stopped";
  answer({indexes: [1], source: "延迟结果", token: "run", chapter: "1"});
  await h.flush();
  assert.equal(h.win.document.querySelectorAll("input")[1].checked, false);
  h.close();
});
test("verification pauses before playback or answering", async () => {
  const h = await harness('<div id="captcha">验证</div><video></video>' + fixture);
  assert.equal(h.state.phase, "paused");
  assert.equal(h.media[0].data.plays, 0);
  assert.equal(h.messages.some(x => x.type === "solve"), false);
  h.close();
});
test("manual submission mode fills but never clicks Submit", async () => {
  const h = await harness(fixture + '<button>提交</button>');
  h.state.options.autoSubmit = false;
  let submits = 0;
  h.win.document.querySelector("button").onclick = () => { submits++; };
  await h.tick();
  assert.equal(h.state.phase, "paused");
  assert.equal(submits, 0);
  assert.match(h.state.note, /自动提交关闭/);
  h.close();
});
test("an unmatched answer pauses without selecting or submitting", async () => {
  const h = await harness(fixture, async () => ({error: "题库未命中"}));
  assert.equal(h.state.phase, "paused");
  assert.equal(h.win.document.querySelectorAll("input")[1].checked, false);
  h.close();
});
test("a question updated in the same container discards its old AI answer", async () => {
  let answer;
  const h = await harness(fixture, () => new Promise(resolve => { answer = resolve; }));
  h.win.document.querySelector(".Zy_TItle").textContent = "【单选题】页面已更新的另一个问题";
  answer({indexes: [1], source: "旧结果", token: "run", chapter: "1"});
  await h.flush();
  assert.equal(h.win.document.querySelectorAll("input")[1].checked, false);
  h.close();
});
test("a next-chapter click that leaves the page unchanged pauses instead of looping", async () => {
  const h = await harness('<div class="work-result">已完成</div><a>下一节</a>');
  let clicks = 0;
  h.win.document.querySelector("a").onclick = () => { clicks++; };
  h.state.advance = true;
  await h.tick();
  h.clock.now += 16000;
  await h.tick();
  assert.equal(clicks, 1);
  assert.equal(h.state.phase, "paused");
  h.close();
});
const visualFixture = '<div class="singleQuesId"><div class="newZy_TItle">【单选题】</div><div class="mark_name font-cxsecret">加密文字占位</div><label><span class="num_option">A</span><span>选项一</span></label><label><span class="num_option">B</span><span>选项二</span></label></div>';
function configureVision({win, state}) {
  state.options.visionEnabled = true;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.html2canvas = async () => ({width: 300, height: 200, toDataURL: () => "data:image/png;base64,dGVzdA=="});
  const labels = [...win.document.querySelectorAll("label")];
  labels.forEach(el => { el.onclick = () => {
    labels.forEach(x => x.querySelector(".num_option").classList.remove("check_answer"));
    el.querySelector(".num_option").classList.add("check_answer");
  }; });
}
test("encrypted question uses an opted-in image request before applying its answer", async () => {
  let request;
  const h = await harness(visualFixture, async message => {
    request = message;
    return {indexes: [1], visual: true, source: "模拟识图", token: "run", chapter: "1"};
  }, configureVision);
  assert.equal(request.image, "data:image/png;base64,dGVzdA==");
  assert.ok(h.win.document.querySelectorAll(".num_option")[1].classList.contains("check_answer"));
  h.close();
});
test("encrypted questions with vision disabled never send images or choose answers", async () => {
  const h = await harness(visualFixture);
  assert.equal(h.state.phase, "paused");
  assert.equal(h.messages.some(x => x.type === "solve"), false);
  h.close();
});
test("cross-origin question images stop before sending a potentially incomplete crop", async () => {
  const h = await harness(visualFixture.replace("加密文字占位", '<img src="https://other.example.test/a.png">'), undefined, context => {
    configureVision(context);
    const image = context.win.document.querySelector("img");
    Object.defineProperty(image, "complete", {value: true});
    Object.defineProperty(image, "naturalWidth", {value: 100});
  });
  assert.equal(h.state.phase, "paused");
  assert.match(h.state.note, /跨域/);
  assert.equal(h.messages.some(x => x.type === "solve"), false);
  h.close();
});
test("blocked autoplay waits for a user play without restarting the task or retry loops", async () => {
  let attempts = 0;
  const h = await harness("<video></video>", undefined, ({media}) => { media[0].video.play = async () => { attempts++; throw new DOMException("blocked", "NotAllowedError"); }; });
  assert.equal(h.state.phase, "running");
  assert.match(h.messages.filter(x => x.type === "report").at(-1).note, /限制自动播放/);
  await h.tick();
  assert.equal(attempts, 1);
  h.media[0].data.paused = false;
  await h.tick();
  assert.equal(h.state.phase, "running");
  assert.equal(h.messages.some(x => x.type === "report" && x.done), false);
  h.close();
});
test("missing options produce a specific parser diagnosis before AI is called", async () => {
  const h = await harness('<div class="TiMu"><div class="Zy_TItle">【单选题】问题</div></div>');
  assert.match(h.state.note, /选项识别不足.*0.*尚未调用 AI/);
  assert.equal(h.messages.some(x => x.type === "solve"), false);
  h.close();
});
test("disabled vision is distinguished from an unsupported question", async () => {
  const h = await harness(visualFixture);
  assert.match(h.state.note, /当前运行未开启识图/);
  assert.equal(h.state.note.includes("未适配题型"), false);
  h.close();
});
test("temporary play interruption retries without requiring user restart", async () => {
  let attempts = 0;
  const h = await harness('<video></video>', undefined, ({media}) => {
    const original = media[0].video.play;
    media[0].video.play = async () => { attempts++; if (attempts === 1) throw new DOMException("interrupted", "AbortError"); await original(); };
  });
  assert.equal(h.state.phase, "running");
  h.clock.now += 3000;
  await h.tick();
  assert.equal(attempts, 2);
  assert.equal(h.media[0].data.paused, false);
  h.close();
});
test("persistent playback failure pauses after three tries", async () => {
  let attempts = 0;
  const h = await harness('<video></video>', undefined, ({media}) => { media[0].video.play = async () => { attempts++; throw new DOMException("interrupted", "AbortError"); }; });
  for (let i = 0; i < 5; i++) { h.clock.now += 10000; await h.tick(); }
  assert.equal(attempts, 3);
  assert.equal(h.state.phase, "paused");
  h.close();
});
test("contextual confirmation is clicked once and its successful result enables advancing", async () => {
  const h = await harness(fixture + '<button id="submit">提交</button><div class="alertDialog" hidden><p>确认提交？</p><button>取消</button><button id="confirm">提交</button></div>');
  const doc = h.win.document;
  let confirmations = 0;
  doc.querySelector("#submit").onclick = () => { doc.querySelector(".alertDialog").hidden = false; };
  doc.querySelector("#confirm").onclick = () => { confirmations++; doc.querySelector(".alertDialog").hidden = true; doc.body.insertAdjacentHTML("beforeend", '<div class="submitStatus">提交成功</div>'); };
  await h.tick();
  await h.tick();
  assert.equal(confirmations, 1);
  await h.tick();
  assert.equal(h.messages.filter(x => x.type === "report").at(-1).done, true);
  assert.equal(h.messages.filter(x => x.type === "solve").length, 1);
  h.close();
});
