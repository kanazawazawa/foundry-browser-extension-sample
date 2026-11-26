import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleSakuraRequest } from "./company-a-sakura/server.mjs";
import { handleYamatoRequest } from "./company-b-yamato/server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MANUALS_DIR = path.resolve(__dirname, "..", "manuals");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function createPortalServer() {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      res.writeHead(400, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("400 Bad Request");
      return;
    }

    if (urlPath.startsWith("/manuals/")) {
      const target = path.resolve(MANUALS_DIR, path.basename(urlPath));
      const rel = path.relative(MANUALS_DIR, target);
      if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(target)) {
        res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(target).pipe(res);
      return;
    }

    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <title>デモランチャー — 経費申請Webアプリ（2社比較）</title>
  <style>
    body { font-family: "Segoe UI", "Meiryo", sans-serif; background: #f8fafc; color: #0f172a; max-width: 920px; margin: 40px auto; padding: 0 24px; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    .lead { color: #475569; margin-bottom: 24px; line-height: 1.6; font-size: 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .card { background: #fff; border-radius: 12px; padding: 22px; border: 1px solid #e2e8f0; }
    .card.sakura { border-top: 4px solid #db2777; }
    .card.yamato { border-top: 4px solid #0f2942; }
    .tag { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 2px 9px; border-radius: 999px; margin-bottom: 8px; }
    .sakura .tag { background: #fce7f3; color: #be185d; }
    .yamato .tag { background: #e2e8f0; color: #0f2942; }
    h2 { margin: 0 0 6px; font-size: 18px; }
    p { font-size: 13.5px; color: #475569; line-height: 1.6; }
    .btns { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
    a.btn { display: block; text-align: center; text-decoration: none; padding: 10px 14px; border-radius: 8px; font-weight: 600; font-size: 13.5px; }
    .sakura a.primary { background: #db2777; color: #fff; }
    .yamato a.primary { background: #0f2942; color: #fff; }
    a.secondary { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
    code { background: #fff; padding: 2px 6px; border-radius: 4px; border: 1px solid #cbd5e1; }
  </style>
</head>
<body>
  <h1>既存 Web システムへの外付け AI 支援 — デモランチャー</h1>
  <p class="lead">
    画面構造も社内規程も異なる2社の業務システムに対し、本体無改修のままブラウザ拡張機能から Foundry Agent（File Search）を重ね合わせて起票作業を支援します。
  </p>
  <div class="grid">
    <div class="card sakura">
      <span class="tag">パターン① モダンSaaS風Webアプリ</span>
      <h2>株式会社さくらテック「Sakura Expense」</h2>
      <p>品川本社・EX予約法人カード・距離別日当・直前申請フラグなどを備えたクラウド型申請フォーム。<br/>対象エージェント: <code>expense-agent-sakura</code></p>
      <div class="btns">
        <a class="btn primary" href="http://localhost:3001" target="_blank" rel="noopener noreferrer">Sakura Expense を開く (Port 3001)</a>
        <a class="btn secondary" href="/manuals/sakura-tech-expense-manual.html" target="_blank" rel="noopener noreferrer">A社 規定マニュアル (HTML)</a>
      </div>
    </div>
    <div class="card yamato">
      <span class="tag">パターン② レガシー基幹ERP風Webアプリ</span>
      <h2>大和重工ロジスティクス「J-Keihi」</h2>
      <p>伝票種別・勘定科目・原価部門コード・宿泊定額制・5万円閾値の決裁ルート判定を備えた基幹伝票画面。<br/>対象エージェント: <code>expense-agent-yamato</code></p>
      <div class="btns">
        <a class="btn primary" href="http://localhost:3002" target="_blank" rel="noopener noreferrer">J-Keihi 基幹システムを開く (Port 3002)</a>
        <a class="btn secondary" href="/manuals/yamato-jkeihi-travel-manual.html" target="_blank" rel="noopener noreferrer">B社 規定マニュアル (HTML)</a>
      </div>
    </div>
  </div>
</body>
</html>`);
  });
}

createPortalServer().listen(3000, "127.0.0.1", () => {
  console.log("Demo Portal Launcher : http://localhost:3000");
});
http.createServer(handleSakuraRequest).listen(3001, "127.0.0.1", () => {
  console.log("Company A (Sakura)   : http://localhost:3001");
});
http.createServer(handleYamatoRequest).listen(3002, "127.0.0.1", () => {
  console.log("Company B (Yamato)   : http://localhost:3002");
});
