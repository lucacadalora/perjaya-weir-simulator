#!/usr/bin/env node
/* Small static file server for REPO/site. Correct MIME types, byte ranges (206), no caching.
   Alone, for a human:   node tools/serve.mjs [--port 8791] [--root <dir>]     (127.0.0.1 only; Ctrl-C stops it)
   From a tool:          import { serve } from "./serve.mjs";
                         const { server, base } = await serve({ port: 0 });  ...  server.close();
   Port 0 (the default for tools) = a free port picked by the system. */
import http from "node:http";
import fs from "node:fs";
import { extname, join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "site");
export const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif",
  ".ico": "image/x-icon", ".ktx2": "image/ktx2", ".basis": "application/octet-stream",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream",
  ".wasm": "application/wasm", ".f32": "application/octet-stream", ".i16": "application/octet-stream",
  ".u8": "application/octet-stream", ".tif": "image/tiff", ".tiff": "image/tiff", ".pbf": "application/x-protobuf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".pdf": "application/pdf",
  ".map": "application/json"
};
const NOCACHE = { "cache-control": "no-store, no-cache, must-revalidate", pragma: "no-cache", expires: "0" };

export function serve({ root = SITE, port = 0, host = "127.0.0.1", quiet = true } = {}) {
  root = resolve(root);
  const server = http.createServer((req, res) => {
    const done = (code, extra = {}, body = "") => { res.writeHead(code, Object.assign({}, NOCACHE, extra)); res.end(body); if (!quiet) console.log(code + " " + req.method + " " + req.url); };
    if (req.method !== "GET" && req.method !== "HEAD") return done(405, { allow: "GET, HEAD" });
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return done(400); }
    let file = resolve(join(root, p));
    if (file !== root && !file.startsWith(root + sep)) return done(403);
    let st;
    try { st = fs.statSync(file); if (st.isDirectory()) { file = join(file, "index.html"); st = fs.statSync(file); } }
    catch { return done(404, { "content-type": "text/plain; charset=utf-8" }, "not found\n"); }
    const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
    const size = st.size, head = { "content-type": type, "accept-ranges": "bytes", "last-modified": st.mtime.toUTCString() };
    const range = req.headers.range;
    let start = 0, end = size - 1, code = 200;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === "" && m[2] === "")) return done(416, { "content-range": "bytes */" + size });
      if (m[1] === "") { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== "") end = Math.min(Number(m[2]), size - 1); }
      if (start >= size || start > end) return done(416, { "content-range": "bytes */" + size });
      code = 206; head["content-range"] = "bytes " + start + "-" + end + "/" + size;
    }
    head["content-length"] = size ? end - start + 1 : 0;
    res.writeHead(code, Object.assign({}, NOCACHE, head));
    if (!quiet) console.log(code + " " + req.method + " " + req.url);
    if (req.method === "HEAD" || size === 0) return res.end();
    fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => ok({ server, base: "http://" + host + ":" + server.address().port }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k, d) => a.includes(k) ? a[a.indexOf(k) + 1] : d;
  const root = resolve(opt("--root", SITE));
  if (!fs.existsSync(root)) { console.error("serve: no folder " + root); process.exit(2); }
  const port = Number(opt("--port", 8791));
  const { server, base } = await serve({ root, port, quiet: !a.includes("--log") }).catch(e => {
    console.error("serve: cannot listen on 127.0.0.1:" + port + " (" + e.code + "); pick another --port, or --port 0 for any free one");
    process.exit(1);
  });
  console.log("serving " + root + " at " + base + "/   (Ctrl-C stops it; --log prints each request)");
  const stop = () => { server.close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
