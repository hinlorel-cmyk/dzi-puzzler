import express from "express";
import { chromium } from "playwright";
import sharp from "sharp";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0 Safari/537.36";

function fail(msg) {
  const e = new Error(msg);
  e.public = true;
  return e;
}

/* ---------------- 瓦片 URL 解析 ---------------- */

function parseTile(url) {
  const m = url.match(
    /\/(\d+)\/(\d+)_(\d+)\.(jpg|jpeg|png|webp)(?:[?#].*)?$/i
  );
  if (!m) return null;

  return {
    url,
    level: Number(m[1]),
    x: Number(m[2]),
    y: Number(m[3]),
    format: m[4].toLowerCase(),
    root: url.replace(
      /\/\d+\/\d+_\d+\.(jpg|jpeg|png|webp)(?:[?#].*)?$/i,
      ""
    )
  };
}

function groupTiles(urls) {
  const groups = new Map();
  for (const u of urls) {
    const t = parseTile(u);
    if (!t) continue;
    if (!groups.has(t.root)) groups.set(t.root, []);
    groups.get(t.root).push(t);
  }
  return [...groups.values()]
    .map(tiles => ({
      root: tiles[0].root,
      format: tiles[0].format,
      maxCapturedLevel: Math.max(...tiles.map(t => t.level)),
      tiles
    }))
    .sort((a, b) => b.tiles.length - a.tiles.length);
}

/* ---------------- Playwright 捕获 ---------------- */

async function captureTiles(pageUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1200 },
      userAgent: UA
    });
    const page = await context.newPage();
    const requests = new Set();

    page.on("request", req => {
      const u = req.url();
      if (/\.(jpg|jpeg|png|webp)(?:[?#]|$)/i.test(u)) {
        requests.add(u);
      }
    });

    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(8000);

    await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 1000));
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 1000));
    });

    await page.waitForTimeout(3000);

    return [...requests];
  } finally {
    await browser.close();
  }
}

/* ---------------- 带 Referer 的下载 ---------------- */

async function fetchBuf(url, referer) {
  const headers = {
    "User-Agent": UA,
    "Accept":
      "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9"
  };
  if (referer) headers.Referer = referer;

  const r = await fetch(url, { headers });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}: ${url}`);
    e.status = r.status;
    e.public = true;
    throw e;
  }
  return Buffer.from(await r.arrayBuffer());
}

/* ---------------- 尝试拿 DZI ---------------- */

async function tryFetchDzi(root, referer) {
  const rootClean = root.replace(/\/+$/, "");
  const candidates = [];

  if (rootClean.endsWith("_files")) {
    candidates.push(rootClean.slice(0, -6) + ".dzi");
  }
  candidates.push(rootClean + ".dzi");

  for (const url of candidates) {
    try {
      const buf = await fetchBuf(url, referer);
      const text = buf.toString("utf8");
      if (/<Image\b/i.test(text)) return { url, xml: text };
    } catch {}
  }
  return null;
}

function parseDziXml(xml, dziUrl) {
  const image = xml.match(/<Image\b[^>]*>/i)?.[0];
  if (!image) throw fail("DZI XML 无效");

  const size = xml.match(
    /<Size\b[^>]*Width=["'](\d+)["'][^>]*Height=["'](\d+)["']/i
  );
  if (!size) throw fail("DZI 缺少 Size");

  const tileSize =
    Number(image.match(/TileSize=["'](\d+)["']/i)?.[1]) || 256;
  const overlap =
    Number(image.match(/Overlap=["'](\d+)["']/i)?.[1]) || 0;
  const format =
    image.match(/Format=["']([^"']+)["']/i)?.[1] || "jpg";

  const width = Number(size[1]);
  const height = Number(size[2]);

  const u = new URL(dziUrl);
  const basePath = u.pathname.replace(/\.dzi$/i, "");
  const tileRoot = `${u.origin}${basePath}_files`;

  return {
    width,
    height,
    tileSize,
    overlap,
    format,
    tileRoot,
    maxLevel: Math.ceil(Math.log2(Math.max(width, height))),
    referer: u.origin + "/"
  };
}

/* ---------------- 无 DZI 时探测瓦片 ---------------- */

async function probeTiles(group, referer) {
  const { root, format, maxCapturedLevel, tiles: captured } = group;
  const rootClean = root.replace(/\/+$/, "");

  let maxLevel = maxCapturedLevel;
  for (let i = 0; i < 12; i++) {
    const next = maxLevel + 1;
    try {
      const buf = await fetchBuf(
        `${rootClean}/${next}/0_0.${format}`,
        referer
      );
      const meta = await sharp(buf).metadata();
      if (meta.width && meta.height) maxLevel = next;
      else break;
    } catch {
      break;
    }
  }

  let minCols = 1, minRows = 1;
  for (const t of captured) {
    if (t.level === maxLevel) {
      minCols = Math.max(minCols, t.x + 1);
      minRows = Math.max(minRows, t.y + 1);
    }
  }

  async function getMeta(x, y) {
    try {
      const buf = await fetchBuf(
        `${rootClean}/${maxLevel}/${x}_${y}.${format}`,
        referer
      );
      return await sharp(buf).metadata();
    } catch {
      return null;
    }
  }

  let cols = minCols;
  while (cols < 300) {
    if (!(await getMeta(cols, 0))) break;
    cols++;
  }

  let rows = minRows;
  while (rows < 300) {
    if (!(await getMeta(0, rows))) break;
    rows++;
  }

  const firstMeta = await getMeta(0, 0);
  const lastMeta = await getMeta(cols - 1, rows - 1);
  if (!firstMeta || !lastMeta) throw fail("无法确定瓦片尺寸");

  let tileSize = 256;
  if (cols > 1) {
    if (firstMeta.width === 512) tileSize = 512;
    else if (firstMeta.width === 256) tileSize = 256;
    else tileSize = firstMeta.width;
  }

  const width =
    cols === 1
      ? firstMeta.width
      : (cols - 1) * tileSize + lastMeta.width;
  const height =
    rows === 1
      ? firstMeta.height
      : (rows - 1) * tileSize + lastMeta.height;

  return {
    width,
    height,
    tileSize,
    overlap: 0,
    format,
    tileRoot: rootClean,
    maxLevel,
    referer
  };
}

/* ---------------- 拼接 ---------------- */

async function buildImage(src) {
  const {
    width,
    height,
    tileSize,
    overlap,
    format,
    tileRoot,
    maxLevel,
    referer
  } = src;

  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const total = cols * rows;

  if (total > 8000) {
    throw fail(`瓦片数量 ${total} 过多（> 8000），已拒绝。`);
  }

  const composites = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const url = `${tileRoot}/${maxLevel}/${x}_${y}.${format}`;
      const buf = await fetchBuf(url, referer);
      const meta = await sharp(buf).metadata();

      const cropLeft = x > 0 ? overlap : 0;
      const cropTop = y > 0 ? overlap : 0;

      const contentW = Math.min(tileSize, width - x * tileSize);
      const contentH = Math.min(tileSize, height - y * tileSize);

      const cropW = Math.min(contentW, meta.width - cropLeft);
      const cropH = Math.min(contentH, meta.height - cropTop);

      let processed = buf;
      const needCrop =
        cropLeft > 0 ||
        cropTop > 0 ||
        cropW !== meta.width ||
        cropH !== meta.height;

      if (needCrop) {
        processed = await sharp(buf)
          .extract({
            left: cropLeft,
            top: cropTop,
            width: cropW,
            height: cropH
          })
          .toBuffer();
      }

      composites.push({
        input: processed,
        left: x * tileSize,
        top: y * tileSize
      });
    }
  }

  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .composite(composites)
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/* ---------------- 从页面 URL 解析出 source ---------------- */

async function resolveSource(pageUrl) {
  const urls = await captureTiles(pageUrl);
  const groups = groupTiles(urls);

  if (!groups.length) {
    throw fail(
      "没捕获到瓦片。可能页面需要登录，或不是 Deep Zoom 结构。"
    );
  }

  const referer = new URL(pageUrl).origin + "/";

  for (const g of groups) {
    const dzi = await tryFetchDzi(g.root, referer);
    if (dzi) {
      try {
        const src = parseDziXml(dzi.xml, dzi.url);
        src.referer = referer;
        return src;
      } catch {}
    }

    try {
      return await probeTiles(g, referer);
    } catch {}
  }

  throw fail("找到了瓦片请求，但无法推断出可拼接的参数。");
}

/* ---------------- source 缓存 ---------------- */

const sourceCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function putSource(src) {
  const token =
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36);

  sourceCache.set(token, { src, at: Date.now() });

  const now = Date.now();
  for (const [k, v] of sourceCache) {
    if (now - v.at > CACHE_TTL) sourceCache.delete(k);
  }

  return token;
}

function getSource(token) {
  const item = sourceCache.get(token);
  if (!item) return null;
  if (Date.now() - item.at > CACHE_TTL) {
    sourceCache.delete(token);
    return null;
  }
  return item.src;
}

/* ---------------- API ---------------- */

app.post("/api/analyze", async (req, res) => {
  const pageUrl = String(req.body?.url || "").trim();
  if (!/^https?:\/\//i.test(pageUrl)) {
    return res.status(400).json({ ok: false, error: "网址格式不正确" });
  }

  try {
    const src = await resolveSource(pageUrl);
    const token = putSource(src);

    const cols = Math.ceil(src.width / src.tileSize);
    const rows = Math.ceil(src.height / src.tileSize);

    res.json({
      ok: true,
      token,
      width: src.width,
      height: src.height,
      tileSize: src.tileSize,
      overlap: src.overlap,
      format: src.format,
      maxLevel: src.maxLevel,
      columns: cols,
      rows,
      tiles: cols * rows
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.public ? e.message : (e.message || String(e))
    });
  }
});

app.post("/api/download", async (req, res) => {
  let src = null;

  const token = String(req.body?.token || "").trim();
  if (token) {
    src = getSource(token);
    if (!src) {
      return res.status(400).json({
        ok: false,
        error: "解析结果已过期，请重新点击「自动解析最高分辨率」。"
      });
    }
  } else {
    const pageUrl = String(req.body?.url || "").trim();
    if (!/^https?:\/\//i.test(pageUrl)) {
      return res.status(400).json({
        ok: false,
        error: "缺少 token 或网址"
      });
    }
    try {
      src = await resolveSource(pageUrl);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.public ? e.message : (e.message || String(e))
      });
    }
  }

  try {
    const buf = await buildImage(src);
    res.set("Content-Type", "image/jpeg");
    res.set("Content-Disposition", 'attachment; filename="image.jpg"');
    res.set("Content-Length", String(buf.length));
    res.send(buf);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.public ? e.message : (e.message || String(e))
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
