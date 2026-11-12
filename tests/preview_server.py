"""Local UI preview with in-memory extension API mocks; no course or AI requests."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json

root = Path(__file__).resolve().parents[1] / "extension"
mock = r'''<script>
(() => {
  const config={muted:false,autoNext:true,autoAnswer:true,autoSubmit:true,aiEnabled:false,visionEnabled:false,apiBase:"",apiKey:"",model:"",maxCalls:1000,confidence:0.9,bank:[],hasKey:false};
  const run={phase:"stopped",note:"尚未启动。进入课程页后，点击下方按钮开始。",calls:0,limit:1000,logs:[]};
  window.chrome={runtime:{getURL:p=>p,onMessage:{addListener(){}},sendMessage:async m=>{
    if(m.type==="getSettings")return structuredClone(config);
    if(m.type==="saveSettings"){Object.assign(config,m.settings);config.hasKey=!!config.apiKey;return {ok:true};}
    if(m.type==="openPage"){location.href=m.page+".html";return {ok:true};}
    if(m.type==="start"||m.type==="stop"){run.phase=m.type==="start"?"running":"stopped";run.note="本地界面预览，不操作课程。";}
    return structuredClone(run);
  }},tabs:{query:async()=>[{id:0}]},permissions:{request:async()=>true}};
})();
</script>'''


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(root), **kwargs)

    def do_GET(self):
        file = self.path.split("?", 1)[0].lstrip("/") or "popup.html"
        if file in ("popup.html", "options.html", "bank.html", "floating.html"):
            if file == "floating.html":
                page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{background:#f3f5fa}</style><body>' + mock + '<script src="core.js"></script><script>CourseCore.scope=()=>"preview";</script><script src="content.js"></script></body></html>'
            else:
                page = (root / file).read_text(encoding="utf-8").replace("<script src=", mock + "<script src=", 1)
            body = page.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(json.dumps({"preview_url": f"http://127.0.0.1:{server.server_port}/popup.html"}), flush=True)
    server.serve_forever()
