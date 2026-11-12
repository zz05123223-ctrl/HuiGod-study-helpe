"use strict";
const $ = id => document.getElementById(id);
async function refresh() {
  const state = await chrome.runtime.sendMessage({type: "overview"});
  if (state.error) throw new Error(state.error);
  $("runCard").dataset.state = state.phase;
  $("phase").textContent = ({running: "运行中", paused: "已暂停", stopped: "未运行"})[state.phase];
  $("note").textContent = state.note;
  $("calls").replaceChildren(document.createTextNode("AI "));
  const count = document.createElement("strong");
  count.textContent = String(state.calls || 0);
  $("calls").append(count, document.createTextNode(` / ${state.limit || 1000}`));
  $("logCount").textContent = state.logs.length ? `${state.logs.length} 条` : "暂无记录";
  $("logs").replaceChildren();
  if (!state.logs.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "开始运行后，记录会显示在这里。"; $("logs").append(empty); }
  for (const entry of [...state.logs].reverse()) {
    const row = document.createElement("div"); row.className = "log-row";
    const time = document.createElement("time"); time.textContent = entry.time.slice(0, 5);
    const text = document.createElement("p"); text.textContent = entry.text;
    row.append(time, text); $("logs").append(row);
  }
}
async function control(type) {
  try {
    $("message").textContent = "";
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const result = await chrome.runtime.sendMessage({type, tabId: tab.id});
    if (result.error) throw new Error(result.error);
    await refresh();
  } catch (error) { $("message").className = "error"; $("message").textContent = error.message; }
}
$("start").onclick = () => control("start");
$("stop").onclick = () => control("stop");
for (const page of ["bank", "options"]) $(page).onclick = () => chrome.runtime.sendMessage({type: "openPage", page});
refresh().catch(error => { $("message").textContent = error.message; });
setInterval(() => refresh().catch(() => {}), 2000);
