const {test} = require("node:test");
const assert = require("node:assert/strict");
const {JSDOM} = require("jsdom");
const C = require("../extension/core.js");
const url = "https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=42&clazzid=9&chapterId=1";
function dom(html) {
  const d = new JSDOM(html, {url});
  d.window.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  return d;
}
function modern(type = "单选题", title = "哪个是水果？", options = ["Apple", "Banana"]) {
  return `<div class="singleQuesId"><span class="newZy_TItle">【${type}】</span><div class="mark_name">${title}</div>${options.map((x, i) => `<label><span class="num_option">${String.fromCharCode(65 + i)}</span><span>${x}</span></label>`).join("")}</div>`;
}
test("course scope accepts study pages only and separates course/class", () => {
  assert.ok(C.scope(url));
  assert.equal(C.scope(url.replace("courseId", "courseid")), C.scope(url));
  for (const bad of [url.replace("chaoxing.com", "chaoxing.com.evil.test"), url.replace("studentstudy", "exam"), url.replace("https:", "http:"), "not a url"]) assert.equal(C.scope(bad), "");
  assert.notEqual(C.scope(url), C.scope(url.replace("clazzid=9", "clazzid=10")));
});
test("endpoint limits schemes, credentials, query strings and builds one endpoint", () => {
  assert.equal(C.endpoint("https://api.example.test/v1").href, "https://api.example.test/v1/chat/completions");
  assert.equal(C.endpoint("http://localhost:11434/v1/chat/completions").href, "http://localhost:11434/v1/chat/completions");
  for (const bad of ["http://remote.test/v1", "https://key:pass@host.test/v1", "https://api.test/v1?key=secret", "file:///tmp"]) assert.throws(() => C.endpoint(bad));
});
test("choice parsing preserves leading English letters and removes display markers", () => {
  const d = dom(modern());
  const [q] = C.questions(d.window.document);
  assert.equal(q.type, "single");
  assert.deepEqual(q.options.map(x => x.text), ["Apple", "Banana"]);
  assert.deepEqual(C.indexes(q, ["Apple"]), [0]);
  assert.equal(C.optionText("A. Apple"), "Apple");
  assert.equal(C.optionText("Apple"), "Apple");
  d.window.close();
});
test("local bank remaps original letter answers by option text after shuffle", () => {
  const q = {title: "1. 【单选题】哪个是水果？", type: "single", options: [{text: "石头"}, {text: "苹果"}]};
  assert.deepEqual(C.fromBank(q, [{question: "哪个是水果？", options: ["苹果", "石头"], answer: ["A"]}]).indexes, [1]);
  assert.equal(C.fromBank(q, [{question: "哪个是水果？", answer: ["A"]}]), null);
  assert.equal(C.fromBank({...q, title: "另一个问题"}, [{question: "哪个是水果？", answer: ["苹果"]}]), null);
});
test("conflicting banks and ambiguous or partial answers cannot be submitted", () => {
  const q = {title: "选一项", type: "single", options: [{text: "红色"}, {text: "蓝色"}]};
  assert.throws(() => C.fromBank(q, [{question: q.title, answer: ["红色"]}, {question: q.title, answer: ["蓝色"]}]), /冲突/);
  assert.throws(() => C.indexes(q, ["红"]));
  assert.throws(() => C.indexes(q, ["红色", "蓝色"]));
  assert.throws(() => C.indexes({...q, options: [{text: "红色"}, {text: "红色"}]}, ["红色"]));
  assert.deepEqual(C.indexes({type: "judgment", options: [{text: "√"}, {text: "×"}]}, ["正确"]), [0]);
});
test("multiple-choice updates wrong selections and repeated application is idempotent", () => {
  const d = dom('<div class="TiMu"><h3 class="Zy_TItle">【多选题】选偶数</h3><label><input type="checkbox" checked>1</label><label><input type="checkbox">2</label><label><input type="checkbox" checked>4</label></div>');
  const [q] = C.questions(d.window.document);
  C.apply(q, [1, 2]);
  assert.ok(C.answered(q, [1, 2]));
  C.apply(q, [1, 2]);
  assert.ok(C.answered(q, [1, 2]));
  d.window.close();
});
test("images, encrypted text and unsupported question types are blocked", () => {
  for (const html of [modern("填空题"), modern().replace("哪个是水果？", '<img src="x">图中是什么？'), modern().replace('class="mark_name"', 'class="mark_name font-cxsecret"')]) {
    const d = dom(html);
    assert.ok(C.questions(d.window.document)[0].blocked);
    assert.throws(() => C.apply(C.questions(d.window.document)[0], [0]));
    d.window.close();
  }
});
test("verification detection ignores hidden widgets and catches visible verification", () => {
  const d = dom('<div hidden id="captcha"></div><p>课程中提到人脸识别技术</p>');
  assert.equal(C.gate(d.window.document), "");
  d.window.document.querySelector("#captcha").hidden = false;
  assert.match(C.gate(d.window.document), /验证码/);
  d.window.close();
});
test("next task tab uses one tab per item rather than clicking a child of the active tab", () => {
  const d = dom('<ul class="prev_ul"><li class="active"><a>课程视频</a></li><li><a>章节测验</a></li></ul><a>下一节</a>');
  assert.equal(C.next(d.window.document).textContent, "章节测验");
  d.window.close();
});
test("advance requires all reported tasks done, including a stale unfinished frame", () => {
  const now = 20000;
  assert.equal(C.canAdvance({}, now), false);
  assert.equal(C.canAdvance({a: {at: now, hasTask: true, done: true}}, now), true);
  assert.equal(C.canAdvance({a: {at: now, hasTask: true, done: true}, b: {at: now, hasTask: true, done: false}}, now), false);
  assert.equal(C.canAdvance({a: {at: now, hasTask: true, done: true}, b: {at: 0, hasTask: true, done: false}}, now), false);
});
test("bank schema rejects malformed entries", () => {
  for (const value of [{}, [{question: "x", answer: "A"}], [{question: "", answer: ["x"]}], [{question: "x", answer: [5]}]]) assert.throws(() => C.validateBank(value));
});
test("short question stems are not replaced by a longer type-only label", () => {
  const d = dom(modern("判断题", "2>1", ["正确", "错误"]));
  assert.equal(C.questions(d.window.document)[0].title, "2>1");
  d.window.close();
});
test("vision labels use visible letters and reject duplicates or nonexistent choices", () => {
  const q = {type: "multiple", options: [{label: "C"}, {label: "A"}, {label: "B"}]};
  assert.deepEqual(C.labelIndexes(q, ["A", "C"]), [0, 1]);
  for (const labels of [["D"], ["A", "A"], [], [1]]) assert.throws(() => C.labelIndexes(q, labels));
  assert.throws(() => C.labelIndexes({...q, type: "single"}, ["A", "B"]));
});
module.exports = {modern, url};
test("legacy choice rows without native inputs expose labels and text", () => {
  const d = dom('<div class="TiMu"><div class="Zy_TItle">【单选题】选偶数</div><ul class="Zy_ulTop"><li class="before-after" role="radio" aria-checked="false"><label class="fl before">A.</label><a class="fl after">1</a></li><li class="before-after" role="radio" aria-checked="true"><label class="fl before">B.</label><a class="fl after">2</a></li></ul></div>');
  const [q] = C.questions(d.window.document);
  assert.deepEqual(q.options.map(o => [o.label, o.text]), [["A", "1"], ["B", "2"]]);
  assert.equal(q.unsupported, false);
  assert.ok(C.answered(q, [1]));
  d.window.close();
});
test("current multi-choice markers use num_option_dx and check_answer_dx", () => {
  const d = dom('<div class="questionLi singleQuesId"><div class="newZy_TItle">【多选题】</div><div class="stem">选偶数</div><div class="stem_answer"><div class="answerBg"><span class="num_option_dx check_answer_dx">A</span><div class="answer_p">2</div></div><div class="answerBg"><span class="num_option_dx">B</span><div class="answer_p">3</div></div></div></div>');
  const [q] = C.questions(d.window.document);
  assert.equal(q.options.length, 2);
  assert.equal(q.title, "选偶数");
  assert.ok(C.answered(q, [0]));
  d.window.close();
});
test("judgment rows without letter markers support visual true/false labels", () => {
  const d = dom('<div class="TiMu"><div class="Zy_TItle">【判断题】2大于1</div><ul class="Zy_ulTop"><li role="radio" aria-checked="false"><a class="after">对</a></li><li role="radio" aria-checked="true"><a class="after">错</a></li></ul></div>');
  const [q] = C.questions(d.window.document);
  assert.equal(q.unsupported, false);
  assert.deepEqual(C.labelIndexes(q, ["错误"]), [1]);
  assert.ok(C.answered(q, [1]));
  d.window.close();
});
test("an empty video quiz placeholder is not an active question", () => {
  const d = dom('<video></video><div class="ans-videoquiz"></div>');
  assert.equal(C.questions(d.window.document).length, 0);
  d.window.close();
});
test("submit confirmation recognizes a contextual dialog without a special button ID", () => {
  const d = dom('<button>提交</button><div class="alertDialog"><h3>提示</h3><p>确认提交？</p><button>取消</button><button class="confirm">提交</button></div>');
  assert.equal(C.submitConfirmation(d.window.document).className, "confirm");
  d.window.close();
});
test("quiz iframe can find the submission dialog in its same-origin parent", () => {
  const d = dom('<iframe></iframe><div role="dialog"><p>确认提交？</p><button>取消</button><button id="confirm">提交</button></div>');
  assert.equal(C.submitConfirmation(d.window.document.querySelector("iframe").contentDocument).id, "confirm");
  d.window.close();
});
test("ordinary buttons and unrelated confirmation dialogs are not quiz confirmations", () => {
  const d = dom('<button>提交</button><div role="dialog"><p>确认删除？</p><button>取消</button><button>确定</button></div>');
  assert.equal(C.submitConfirmation(d.window.document), null);
  d.window.close();
});
test("submission status and actual course tabs are recognized", () => {
  const d = dom('<div class="submitStatus">提交成功</div><ul id="prev_tab"><li id="dct1" class="currents">视频</li><li id="dct2">章节测验</li></ul><button>下一节</button>');
  assert.equal(C.review(d.window.document), true);
  assert.equal(C.next(d.window.document).id, "dct2");
  d.window.close();
});
test("a known generic dialog button is rejected when the dialog is about deletion", () => {
  const d = dom('<div class="layui-layer"><p>确认删除？</p><button>取消</button><button class="layui-layer-btn0">确定</button></div>');
  assert.equal(C.submitConfirmation(d.window.document), null);
  d.window.close();
});
