"use strict";
const $ = id => document.getElementById(id);
const toggles = ["muted", "autoNext", "autoAnswer", "autoSubmit", "aiEnabled", "visionEnabled"];
const fields = ["apiBase", "model", "maxCalls", "confidence"];
async function load() {
  const config = await chrome.runtime.sendMessage({type: "getSettings"});
  if (config.error) throw new Error(config.error);
  for (const key of toggles) $(key).checked = config[key];
  for (const key of fields) $(key).value = config[key];
  $("clearKey").checked = false;
  $("keyState").textContent = config.hasKey ? "已保存密钥 · 不在页面回显" : "尚未保存密钥 · 本机免密服务可留空";
}
$("settings").onsubmit = async event => {
  event.preventDefault();
  $("save").disabled = true;
  $("message").className = "";
  try {
    const config = {};
    for (const key of toggles) config[key] = $(key).checked;
    for (const key of fields) config[key] = $(key).value;
    config.apiKey = $("apiKey").value;
    if ($("clearKey").checked && config.apiKey.trim()) throw new Error("不能同时填写新密钥并勾选删除密钥；请取消勾选后保存");
    if (config.aiEnabled) {
      const url = CourseCore.endpoint(config.apiBase.trim());
      if (!config.model.trim()) throw new Error("请填写模型名称");
      const granted = await chrome.permissions.request({origins: [url.origin + "/*"]});
      if (!granted) throw new Error("未获 API 站点权限，设置未保存");
    }
    const result = await chrome.runtime.sendMessage({type: "saveSettings", settings: config, clearKey: $("clearKey").checked});
    if (result.error) throw new Error(result.error);
    $("apiKey").value = "";
    await load();
    $("message").textContent = "已保存。返回课程页重新启动后生效。";
  } catch (error) { $("message").className = "error"; $("message").textContent = error.message; }
  finally { $("save").disabled = false; }
};
load().catch(error => { $("message").className = "error"; $("message").textContent = error.message; });
