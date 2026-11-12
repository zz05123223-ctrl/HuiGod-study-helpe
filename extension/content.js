(function () {
  "use strict";
  const C = CourseCore;
  const topFrame = window === window.top;
  const ownedVideos = new Set();
  const solved = new WeakMap();
  const playback = new WeakMap();
  const docKey = crypto.randomUUID();
  let state, busy = false, generation = "", submitAt = 0, confirmed = false, advancedAt = 0, advancedSignature = "", firstTaskAt = 0;
  let panel, statusText, detailText;
  async function send(type, extra = {}) {
    const result = await chrome.runtime.sendMessage({type, token: state?.token, chapter: state?.chapter, docKey, ...extra});
    if (result?.error) throw new Error(result.error);
    return result;
  }
  const pause = note => send("pause", {note});
  const button = (selector, pattern) => [...document.querySelectorAll(selector)].find(el => C.visible(el) && !el.disabled && pattern.test((el.value || el.textContent).trim()));
  const review = () => C.review(document);
  const fingerprint = question => JSON.stringify([question.type, question.title, question.options.map(o => [o.label, o.text])]);
  const navigation = () => location.href + [...document.querySelectorAll("iframe, #prev_tab .currents, .prev_ul .active, .prev_ul .on, [role=tab][aria-selected=true]")].map(el => el.getAttribute("src") || el.textContent).join("|");
  window.addEventListener("pagehide", () => { send("depart").catch(() => {}); });
  function stopVideos() {
    for (const video of ownedVideos) if (video.isConnected && !video.paused) video.pause();
    ownedVideos.clear();
  }
  chrome.runtime.onMessage.addListener((message, _, respond) => {
    if (message.type === "ping") respond({ready: true});
    if (message.type === "halt") { stopVideos(); if (state) state.phase = "stopped"; respond({ok: true}); }
  });
  async function questionImage(question) {
    if (typeof html2canvas !== "function") throw new Error("识图库未加载，请刷新页面");
    C.labelIndexes(question, [question.options[0].label]); // Confirm every option has a unique display letter.
    for (const img of question.el.querySelectorAll("img")) {
      const src = img.currentSrc || img.src;
      if (!img.complete || !img.naturalWidth || (!src.startsWith("data:") && new URL(src, location.href).origin !== location.origin)) throw new Error("题目有未加载或跨域图片，无法确认截图完整，请人工处理");
    }
    question.el.scrollIntoView({block: "center"});
    let timeout;
    try {
      const canvas = await Promise.race([
        html2canvas(question.el, {backgroundColor: "#ffffff", scale: 1, logging: false, imageTimeout: 5000, allowTaint: false, useCORS: false}),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("题目截图超过 15 秒，请人工处理")), 15000); })
      ]);
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > 6000000) throw new Error("题目截图尺寸异常，请人工处理");
      return canvas.toDataURL("image/png");
    } finally { clearTimeout(timeout); }
  }
  function mount() {
    if (!topFrame || !C.scope(location.href) || panel) return;
    panel = document.createElement("div");
    panel.style.cssText = "position:fixed;right:18px;bottom:22px;z-index:2147483647;width:290px";
    const shadow = panel.attachShadow({mode: "closed"});
    shadow.innerHTML = '<style>:host{font:13px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#293248}.box{background:linear-gradient(135deg,#ffffffee,#f7f9ffed);backdrop-filter:blur(22px);border:1px solid #fff;border-radius:24px;box-shadow:0 12px 44px #18356918;padding:18px}.brand{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:650}.book{display:grid;place-items:center;background:linear-gradient(140deg,#80b9ff,#527dff);color:#fff;width:29px;height:29px;border-radius:10px}.version{margin-left:auto;color:#a2acc0;font-size:10px;font-weight:400}#status{margin:13px 0 5px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px}#status:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#a8b2c7}#status[data-state=running]:before{background:#38c991}#status[data-state=paused]:before{background:#e8b16c}#detail{font-size:11px;color:#8994ac;line-height:1.8;display:block;max-height:78px;overflow:auto;margin-bottom:13px;overflow-wrap:anywhere}button{font:inherit;border:0;border-radius:12px;cursor:pointer}#halt{width:100%;padding:9px;background:#eaf1ff;color:#447cc0;font-size:12px}.portals{display:flex;gap:7px;margin-top:8px}.portals button{flex:1;padding:7px;font-size:11px;background:#edf4ff;color:#6089bd}.portals #ai{background:#f0ebff;color:#9274bc}.foot{font-size:9px;color:#a8b1c4;text-align:center;margin-top:10px}svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}</style><section class="box"><div class="brand"><span class="book"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/></svg></span>学习通自用助手<span class="version">0.2.0</span></div><p id="status">等待启动</p><span id="detail">点击浏览器扩展图标启动。</span><button id="halt">停止运行</button><div class="portals"><button id="bank">题库管理</button><button id="ai">AI 设置</button></div><div class="foot">完成状态以平台为准</div></section>';
    statusText = shadow.querySelector("#status");
    detailText = shadow.querySelector("#detail");
    shadow.querySelector("#halt").onclick = () => pause("用户停止了运行");
    shadow.querySelector("#bank").onclick = () => send("openPage", {page: "bank"});
    shadow.querySelector("#ai").onclick = () => send("openPage", {page: "options"});
    document.documentElement.append(panel);
  }
  async function pulse() {
    if (busy) return;
    busy = true;
    try {
      state = await send("state");
      mount();
      if (statusText) {
        statusText.dataset.state = state.phase;
        statusText.textContent = ({running: "运行中", paused: "已暂停", stopped: "未运行"})[state.phase] || "未运行";
        detailText.textContent = state.note || "请通过扩展图标启动。";
      }
      if (state.phase !== "running") {
        stopVideos();
        return;
      }
      const newGeneration = `${state.token}|${state.chapter}`;
      if (generation !== newGeneration) {
        generation = newGeneration;
        submitAt = 0; confirmed = false; advancedAt = 0; firstTaskAt = Date.now();
      }
      if (advancedAt && Date.now() - advancedAt > 15000) {
        if (navigation() === advancedSignature) return await pause("切换任务后页面没有变化，请手动打开下一节，不会反复点击");
        advancedAt = 0;
        firstTaskAt = Date.now();
      }
      if (/\/exam-ans\/exam\//i.test(location.pathname) || /\/exam\/test/i.test(location.pathname)) return await pause("正式考试页面需人工处理");
      const verification = C.gate(document);
      if (verification) return await pause(verification);
      if (submitAt && !confirmed && state.options.autoSubmit && !review()) {
        const confirm = C.submitConfirmation(document);
        if (confirm) {
          const latest = await send("state");
          if (latest.phase !== "running" || latest.token !== state.token) return;
          confirmed = true;
          submitAt = Date.now();
          confirm.click();
          await send("report", {hasTask: true, done: false, note: "已确认提交，等待平台结果"});
          return;
        }
      }
      const items = C.questions(document);
      const videos = [...document.querySelectorAll("video")];
      if (!review()) {
        const unsupported = items.findIndex(q => q.unsupported);
        if (unsupported >= 0) return await pause(`第 ${unsupported + 1} 题：${items[unsupported].reason}。尚未调用 AI`);
        const visual = items.findIndex(q => q.visual);
        if (visual >= 0 && !state.options.visionEnabled) return await pause(`第 ${visual + 1} 题含图片或加密文字；当前运行未开启识图。请保存 AI/识图设置后重新启动`);
      }
      if (items.length && !review()) {
        if (!state.options.autoAnswer) return await pause("当前有题目，自动答题已关闭，请人工作答");
        for (const question of items) {
          const saved = solved.get(question.el);
          const signature = fingerprint(question);
          if (saved?.generation === generation && saved.signature === signature && C.answered(question, saved.indexes)) continue;
          const image = question.visual ? await questionImage(question) : undefined;
          const result = await send("solve", {image, question: {title: question.title, type: question.type, options: question.options.map(o => ({text: o.text, label: o.label}))}});
          const latest = await send("state"); // Do not apply late answers after Stop/navigation.
          if (latest.phase !== "running" || latest.token !== state.token || latest.chapter !== state.chapter || result.token !== state.token || result.chapter !== state.chapter || !question.el.isConnected) return;
          const fresh = C.questions(document).find(q => q.el === question.el);
          if (!fresh || fingerprint(fresh) !== signature) return;
          if (C.gate(document)) return await pause("作答前出现身份验证，请人工处理");
          C.apply(result.visual && fresh.visual ? {...fresh, blocked: fresh.unsupported} : fresh, result.indexes);
          await new Promise(resolve => setTimeout(resolve, 600)); // Allow native save handlers to update selection.
          const verified = C.questions(document).find(q => q.el === question.el);
          if (!verified || fingerprint(verified) !== signature || !C.answered(verified, result.indexes)) return await pause("点击后题目发生变化或未确认选中，停止提交，请人工核对");
          solved.set(question.el, {generation, signature, indexes: result.indexes});
          await send("report", {hasTask: true, done: false, note: `已填写一道题（${result.source}）`});
          return; // Keep page save requests sequential.
        }
        if (!state.options.autoSubmit) return await pause("当前选择题已填写，自动提交关闭，请核对后自行提交");
        if (!submitAt) {
          const submit = button('a,button,input[type="submit"]', /^(提交|提交作业|提交答案|提交测验|交卷)$/);
          if (!submit) return await pause("未识别到可用的提交按钮，请人工提交");
          submitAt = Date.now();
          submit.click();
          return;
        }
        if (Date.now() - submitAt > 45000) return await pause(confirmed ? "已确认提交，但未识别到成功结果，请核对平台记录，不会重复提交" : "未找到可识别的提交确认按钮，请手动确认，不会重复交卷");
        await send("report", {hasTask: true, done: false, note: "已点击提交，等待平台结果"});
        return;
      }
      for (const video of videos) {
        if (video.ended) continue;
        video.playbackRate = 1;
        video.muted = state.options.muted;
        let attempt = playback.get(video);
        const source = `${generation}|${video.currentSrc || video.getAttribute("src") || ""}`;
        if (!attempt || attempt.source !== source) { attempt = {source, tries: 0, nextAt: 0, blocked: false}; playback.set(video, attempt); }
        if (!video.paused) { attempt.tries = 0; attempt.blocked = false; continue; }
        if (attempt.blocked) { await send("report", {hasTask: true, done: false}); return; }
        if (Date.now() < attempt.nextAt) return;
        if (video.error?.code === 4) return await pause("视频源不可用或格式不支持，请检查播放器线路");
        if (video.paused) {
          let timeout;
          ownedVideos.add(video);
          try {
            await Promise.race([video.play(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error("播放请求超时"), {name: "TimeoutError"})), 8000); })]);
            attempt.tries = 0;
            if (state.phase !== "running") { video.pause(); return; }
          } catch (error) {
            if (state.phase !== "running") return;
            if (error.name === "NotAllowedError") {
              attempt.blocked = true;
              await send("report", {hasTask: true, done: false, note: "浏览器限制自动播放：请点一次播放器，助手将自动继续，无需重新启动"});
              return;
            }
            if (error.name === "NotSupportedError") return await pause("播放器不支持当前视频源，请检查线路");
            attempt.tries++;
            if (attempt.tries >= 3) return await pause("视频连续 3 次播放失败，请检查网络或手动播放后重新启动");
            attempt.nextAt = Date.now() + attempt.tries * 2000;
            await send("report", {hasTask: true, done: false, note: `视频暂时中断，准备第 ${attempt.tries + 1}/3 次播放尝试`});
            return;
          } finally { clearTimeout(timeout); }
        }
      }
      const finishedMarker = [...document.querySelectorAll(".ans-job")];
      const markedDone = finishedMarker.length > 0 && finishedMarker.every(el => el.classList.contains("ans-job-finished"));
      const hasTask = videos.length > 0 || items.length > 0 || markedDone || review();
      const done = (videos.length > 0 && videos.every(v => v.ended) && !items.length) || review() || (markedDone && !videos.some(v => !v.ended) && !items.length);
      await send("report", {hasTask, done, note: hasTask ? (done ? "当前任务页面已结束，等待其他页面" : `视频播放中（${videos.filter(v => v.ended).length}/${videos.length} 已结束）`) : undefined});
      if (topFrame && state.options.autoNext && state.advance && Date.now() - advancedAt > 15000) {
        const target = C.next(document);
        if (!target) return await pause("当前任务已结束，未找到下一个任务入口；请核对目录");
        const latest = await send("state");
        if (latest.phase !== "running" || latest.token !== state.token || !latest.advance || C.gate(document)) return;
        const proceed = await send("advancing");
        if (!proceed?.ok) return;
        advancedSignature = navigation();
        advancedAt = Date.now();
        target.click();
      }
      if (topFrame && Date.now() - firstTaskAt > 60000 && !state.advance && !hasTask && /没有学习任务|暂无任务/.test(document.body.innerText || "")) await pause("页面没有可识别的学习任务，请手动选择章节");
    } catch (error) {
      if (state?.phase === "running") { try { await pause(error.message); } catch { /* Extension may have been reloaded. */ } }
      if (detailText) detailText.textContent = error.message;
    } finally { busy = false; }
  }
  pulse();
  setInterval(pulse, 3000);
})();
