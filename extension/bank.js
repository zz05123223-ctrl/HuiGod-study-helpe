"use strict";
const $ = id => document.getElementById(id);
function count() {
  try { $("bankCount").textContent = String(CourseCore.validateBank(JSON.parse($("bank").value)).length); }
  catch { $("bankCount").textContent = "—"; }
}
async function load() {
  const config = await chrome.runtime.sendMessage({type: "getSettings"});
  if (config.error) throw new Error(config.error);
  $("bank").value = JSON.stringify(config.bank, null, 2);
  count();
}
$("bank").oninput = count;
$("import").onchange = async event => {
  $("message").className = "";
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) throw new Error("题库文件不能超过 4 MB");
    const bank = CourseCore.validateBank(JSON.parse((await file.text()).replace(/^\uFEFF/, "")));
    $("bank").value = JSON.stringify(bank, null, 2);
    count();
    $("message").textContent = `已读入 ${bank.length} 道题，保存后替换当前题库。`;
  } catch (error) { $("message").className = "error"; $("message").textContent = error.message; }
};
$("bankForm").onsubmit = async event => {
  event.preventDefault();
  $("save").disabled = true;
  $("message").className = "";
  try {
    const bank = CourseCore.validateBank(JSON.parse($("bank").value));
    const result = await chrome.runtime.sendMessage({type: "saveSettings", settings: {bank}});
    if (result.error) throw new Error(result.error);
    count();
    $("message").textContent = `已保存 ${bank.length} 道题。返回课程页重新启动后生效。`;
  } catch (error) { $("message").className = "error"; $("message").textContent = error.message; }
  finally { $("save").disabled = false; }
};
load().catch(error => { $("message").className = "error"; $("message").textContent = error.message; });
