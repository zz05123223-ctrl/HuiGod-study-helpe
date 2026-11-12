/* Independent implementation. Shared by the extension and local DOM tests. */
(function (root) {
  "use strict";
  const defaults = {
    muted: false, autoNext: true, autoAnswer: true, autoSubmit: true,
    aiEnabled: false, visionEnabled: false, apiBase: "", apiKey: "", model: "", maxCalls: 1000,
    confidence: 0.9, bank: []
  };
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
  const optionText = value => String(value ?? "").replace(/^\s*[A-H](?:[.、．:：)）]\s*|\s+)/i, "").trim();
  const stem = value => clean(String(value).replace(/^\s*\d+[.、．)）]\s*/, "").replace(/[【\[][^】\]]*题[】\]]/g, ""));
  function canonical(value) {
    const text = clean(optionText(value)).toLowerCase();
    if (["正确", "对", "是", "√", "true"].includes(text)) return "true";
    if (["错误", "错", "否", "×", "false"].includes(text)) return "false";
    return text;
  }
  function scope(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" || !u.hostname.endsWith(".chaoxing.com") || !/\/mycourse\/studentstudy\/?$/i.test(u.pathname)) return "";
      const p = Object.fromEntries([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
      return p.courseid ? `${u.hostname}|${p.courseid}|${p.clazzid || p.classid || ""}` : "";
    } catch { return ""; }
  }
  function chapter(raw) {
    const p = Object.fromEntries([...new URL(raw).searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    return p.chapterid || p.knowledgeid || "current";
  }
  function endpoint(raw) {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)))) throw new Error("API 地址须为 HTTPS 或本机 HTTP，且不能含账号、查询参数或片段");
    u.pathname = u.pathname.replace(/\/$/, "").replace(/\/chat\/completions$/, "") + "/chat/completions";
    return u;
  }
  function validateBank(bank) {
    if (!Array.isArray(bank) || bank.length > 10000) throw new Error("题库必须是最多 10000 条的 JSON 数组");
    for (const entry of bank) {
      if (!entry || typeof entry.question !== "string" || !entry.question.trim() || !Array.isArray(entry.answer) || !entry.answer.length || !entry.answer.every(x => typeof x === "string") || (entry.options !== undefined && (!Array.isArray(entry.options) || !entry.options.every(x => typeof x === "string")))) throw new Error("每条题库需要 question 字符串和 answer 字符串数组；options 可选");
    }
    return bank;
  }
  function indexes(question, answer) {
    if (!Array.isArray(answer) || !answer.length || !answer.every(x => typeof x === "string")) throw new Error("答案格式无效");
    const result = answer.map(text => {
      const matches = question.options.map((o, i) => canonical(o.text) === canonical(text) ? i : -1).filter(i => i >= 0);
      if (matches.length !== 1) throw new Error("答案无法唯一匹配当前选项，请人工核对");
      return matches[0];
    });
    if (new Set(result).size !== result.length || (question.type !== "multiple" && result.length !== 1)) throw new Error("答案数量与题型不符");
    return result.sort((a, b) => a - b);
  }
  function labelIndexes(question, labels) {
    const known = question.options.map(o => o.label);
    const normalize = value => question.type === "judgment" ? canonical(value) : value;
    const keys = known.map(normalize);
    const answers = Array.isArray(labels) ? labels.map(normalize) : [];
    if (known.some(x => !/^[A-H]$/.test(x) && !(question.type === "judgment" && ["true", "false"].includes(canonical(x)))) || new Set(keys).size !== keys.length || !answers.length || answers.some(x => !keys.includes(x)) || new Set(answers).size !== answers.length || (question.type !== "multiple" && answers.length !== 1)) throw new Error("识图答案无法匹配当前显示的选项标识，请人工核对");
    return answers.map(x => keys.indexOf(x)).sort((a, b) => a - b);
  }
  function fromBank(question, bank) {
    const entries = bank.filter(e => stem(e.question) === stem(question.title));
    const matches = [];
    for (const entry of entries) {
      let answer = entry.answer;
      if (answer.every(a => /^[A-H]$/i.test(a))) {
        if (!entry.options) continue; // Letters need the original option snapshot.
        answer = answer.map(a => entry.options[a.toUpperCase().charCodeAt(0) - 65]);
        if (answer.some(x => x === undefined)) continue;
      }
      if (entry.options && (entry.options.length !== question.options.length || entry.options.some(x => !question.options.some(o => canonical(x) === canonical(o.text))))) continue;
      try { matches.push(indexes(question, answer)); } catch { /* A different version of this question. */ }
    }
    if (!matches.length) return null;
    if (matches.some(x => JSON.stringify(x) !== JSON.stringify(matches[0]))) throw new Error("本地题库有冲突答案，请先修正");
    return {indexes: matches[0], source: "本地题库"};
  }
  const visible = el => !!el && !el.hidden && el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0;
  function selected(option) {
    if (option.input) return option.input.checked;
    const aria = option.target.getAttribute("aria-checked");
    if (aria === "true" || aria === "false") return aria === "true";
    return !!(option.marker?.matches(".check_answer, .check_answer_dx") || option.target.classList.contains("checked"));
  }
  function questions(doc) {
    const selector = ".singleQuesId, .TiMu, .questionLi, .ans-videoquiz";
    return [...doc.querySelectorAll(selector)].filter(el => visible(el) && !el.parentElement?.closest(selector) && !(el.matches(".ans-videoquiz") && !el.textContent.trim() && !el.querySelector("input,img"))).map(el => {
      const headings = [...el.querySelectorAll(".mark_name, .question-title, .question-stem, .stem, .Zy_TItle, .newZy_TItle, .ans-videoquiz-title")];
      const title = headings.map(x => x.textContent.trim()).filter(x => stem(x)).sort((a, b) => b.length - a.length)[0] || "";
      const typeLabel = headings.map(x => x.textContent).join(" ");
      const type = /多选/.test(typeLabel) ? "multiple" : /判断/.test(typeLabel) ? "judgment" : /单选/.test(typeLabel) ? "single" : "unsupported";
      let options = [...el.querySelectorAll("span.num_option, span.num_option_dx")].map(marker => {
        const target = marker.closest(".answerBg, li") || marker.parentElement;
        const copy = target.cloneNode(true);
        copy.querySelectorAll(".num_option, .num_option_dx").forEach(x => x.remove());
        const text = (target.querySelector(".answer_p, a.after") || copy).textContent.trim();
        return {marker, target, text, label: marker.textContent.trim().replace(/[.、．:：)）]/g, "").toUpperCase()};
      });
      if (!options.length) {
        const legacy = [...el.querySelectorAll(".Zy_ulTop li")];
        const rows = legacy.length ? legacy : [...el.querySelectorAll('[role="radio"], [role="checkbox"]')];
        options = rows.map(target => {
          const labelNode = target.querySelector("label.before, .before");
          const content = target.querySelector("a.after, .answer_p, .after");
          let text = (content?.textContent || target.getAttribute("aria-label") || target.textContent).trim();
          if (type === "judgment") text = text.replace(/选择$/, "");
          const letter = labelNode?.textContent.trim().match(/^([A-H])[.、．:：)）]?$/i)?.[1]?.toUpperCase();
          return {target, text, label: letter || (type === "judgment" && ["true", "false"].includes(canonical(text)) ? text : "")};
        });
      }
      if (!options.length) options = [...el.querySelectorAll('input[type="radio"], input[type="checkbox"]')].map(input => {
        const target = input.closest("label") || input.closest("li") || input;
        const label = input.id ? [...el.querySelectorAll("label")].find(x => x.htmlFor === input.id) : null;
        const text = (label || target).textContent;
        return {input, target: label || target, text: optionText(text), label: text.trim().match(/^([A-H])(?:[.、．:：)）]|\s)/i)?.[1]?.toUpperCase() || ""};
      });
      const hasImage = headings.some(h => h.querySelector("img, svg, canvas")) || options.some(o => o.target.querySelector("img, svg, canvas"));
      const encrypted = el.matches(".font-cxsecret") || !!el.querySelector(".font-cxsecret") || /[\uE000-\uF8FF]/.test(title + options.map(o => o.text).join(""));
      const unsupported = type === "unsupported" || options.length < 2 || (!hasImage && (!title || options.some(o => !o.text)));
      const reason = type === "unsupported" ? "题型尚未识别或未适配" : options.length < 2 ? `选项识别不足（识别到 ${options.length} 个），需适配当前题目控件` : !title ? "未识别到题干" : options.some(o => !o.text) && !hasImage ? "选项文字读取不完整" : "";
      return {el, title, type, options, reason, visual: hasImage || encrypted, unsupported, blocked: unsupported || hasImage || encrypted};
    });
  }
  function apply(question, desired) {
    if (question.blocked) throw new Error("题目含图片、加密字体或未适配题型，请人工处理");
    if (question.options.some(o => o.input?.disabled || o.target.getAttribute("aria-disabled") === "true")) throw new Error("题目不能编辑");
    for (let i = 0; i < question.options.length; i++) {
      const option = question.options[i];
      if (selected(option) !== desired.includes(i) && (desired.includes(i) || question.type === "multiple")) option.target.click();
    }
  }
  function answered(question, desired) {
    return question.options.every((o, i) => selected(o) === desired.includes(i));
  }
  function gate(doc) {
    const widgets = [...doc.querySelectorAll('input[placeholder*="验证码"], iframe[src*="captcha"], .nc-container, #captcha, .yidun_panel, .verify-wrap')];
    if (widgets.some(visible)) return "检测到验证码，请手动完成后重新启动";
    const dialogs = [...doc.querySelectorAll('[role="dialog"], .layui-layer, .popDiv, .maskDiv, .face-recognition')].filter(visible);
    if (dialogs.some(x => /验证码|人脸识别|身份核验|滑块验证|拖动滑块/.test(x.textContent))) return "检测到验证弹窗，请手动处理后重新启动";
    return "";
  }
  function submitConfirmation(doc) {
    const controls = 'button,a,input[type="button"],input[type="submit"],[role="button"]';
    const label = el => (el.value || el.textContent).trim();
    const confirmText = /^(提交|确认提交|确定|确认|交卷)$/;
    const context = /(?:确认|是否|确定).*(?:提交|交卷)/;
    const matches = new Set();
    const visited = new Set();
    for (let current = doc; current && !visited.has(current);) {
      visited.add(current);
      if (gate(current)) throw new Error("提交确认前出现身份验证，请人工处理");
      for (const el of current.querySelectorAll(controls)) {
        if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true" || !confirmText.test(label(el))) continue;
        const modal = el.closest('[role="dialog"],.layui-layer,.popDiv,.alertDialog');
        const known = el.matches("#popok,.layui-layer-btn0,[data-action=confirm-submit]") && (!modal || context.test(clean(modal.textContent)));
        let contextual = false;
        for (let box = el.parentElement, depth = 0; box && box !== current.body && depth < 6; box = box.parentElement, depth++) {
          if (box.textContent.length < 500 && context.test(clean(box.textContent)) && [...box.querySelectorAll(controls)].some(x => visible(x) && /^取消$/.test(label(x)))) { contextual = true; break; }
        }
        if (contextual || known) matches.add(el);
      }
      try {
        const win = current.defaultView;
        current = win && win.parent !== win ? win.parent.document : null;
      } catch { current = null; } // Cross-origin parent: keep normal browser isolation.
    }
    if (matches.size > 1) throw new Error("发现多个提交确认按钮，请人工确认，避免重复提交");
    return [...matches][0] || null;
  }
  function review(doc) {
    const path = new URL(doc.URL).pathname;
    return /selectWorkQuestionYiPiYue|work\/viewResult/i.test(path) || [...doc.querySelectorAll(".workScore,.work-result,.result-score,.submitStatus,.workStatus,.work-status,[data-quiz-completed=true]")].some(el => visible(el) && (el.getAttribute("data-quiz-completed") === "true" || /已提交|已完成|待批阅|待评阅|已批阅|提交成功|得分/.test(el.textContent)));
  }
  function next(doc) {
    const primaryTabs = [...doc.querySelectorAll('#prev_tab li[id^="dct"], .prev_ul li, .tabtags li, [role=tab]')];
    const tabs = (primaryTabs.length ? primaryTabs : [...doc.querySelectorAll(".prev_ul a")]).filter(visible);
    const current = tabs.findIndex(x => x.matches(".active, .on, .curr, .current, .currents, [aria-selected=true]") || !!x.querySelector(".active, .on, .curr"));
    if (current >= 0 && current + 1 < tabs.length) return tabs[current + 1].querySelector("a,button") || tabs[current + 1];
    const candidates = [...doc.querySelectorAll("#prevNextFocusNext, .nextChapter, a, button")].filter(visible);
    return candidates.find(x => !x.disabled && x.getAttribute("aria-disabled") !== "true" && !x.classList.contains("disabled") && /^(下一[章节节]|下一节课|下一个任务)[>›»]?\s*$/.test(x.textContent.trim())) || null;
  }
  function canAdvance(frames, now) {
    const tasks = Object.values(frames).filter(f => f.hasTask);
    return tasks.some(f => now - f.at < 15000) && tasks.every(f => f.done && !f.blocked);
  }
  const api = {defaults, clean, stem, optionText, canonical, scope, chapter, endpoint, validateBank, indexes, labelIndexes, fromBank, visible, selected, questions, apply, answered, gate, submitConfirmation, review, next, canAdvance};
  root.CourseCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
