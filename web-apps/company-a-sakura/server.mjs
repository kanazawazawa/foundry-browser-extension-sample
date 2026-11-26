import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3001);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

export function handleSakuraRequest(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    res.writeHead(400, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end("400 Bad Request");
    return;
  }

  if (urlPath === "/health") {
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok", app: "sakura-expense" }));
    return;
  }

  let filePath;
  if (urlPath === "/" || urlPath === "/index.html") {
    filePath = path.join(__dirname, "index.html");
  } else if (urlPath === "/manual" || urlPath === "/manual.html") {
    const localCopy = path.join(__dirname, "manual.html");
    const repoCopy = path.resolve(__dirname, "..", "..", "manuals", "sakura-tech-expense-manual.html");
    filePath = fs.existsSync(localCopy) ? localCopy : repoCopy;
  } else {
    filePath = path.resolve(__dirname, urlPath.replace(/^\/+/, ""));
    const rel = path.relative(__dirname, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      res.writeHead(403, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("403 Forbidden");
      return;
    }
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(res);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  http.createServer(handleSakuraRequest).listen(PORT, "0.0.0.0", () => {
    console.log(`Sakura Expense listening on port ${PORT}`);
  });
}
