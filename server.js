import express from "express";
import { chromium } from "playwright";
import sharp from "sharp";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeDeepZoom(obj) {
  if (!obj || typeof obj !== "object") return false;

  const keys = Object.keys(obj).map(k => k.toLowerCase());

  const hasUrl =
    keys.includes("url") ||
    keys.includes("tileurl") ||
    keys.includes("tilesurl");

  const hasSize =
    keys.includes("size") ||
    (keys.includes("width") && keys.includes("height"));

  const hasTile =
    keys.includes("tilesize") ||
    keys.includes("tile_size");

  return hasUrl && hasSize && hasTile;
}

function findDeepZoomObjects(root) {
  const results = [];
  const seen = new WeakSet();

  function walk(value, path, depth) {
    if (!value || typeof value !== "object") return;
    if (depth > 8) return;
    if (seen.has(value)) return;

    seen.add(value);

    try {
      if (looksLikeDeepZoom(value)) {
        results.push({
          path,
          value
        });
      }
    } catch {}

    let keys = [];
    try {
      keys = Object.keys(value);
    } catch {
      return;
    }

    for (const key of keys.slice(0, 300)) {
      let child;

      try {
        child = value[key];
      } catch {
        continue;
      }

      if (
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        walk(child, `${path}.${key}`, depth + 1);
      }
    }
  }

  walk(root, "window", 0);
  return results;
}

function normalizeSource(x) {
  if (!x || typeof x !== "object") return null;

  let url =
    x.Url ??
    x.url ??
    x.TileUrl ??
    x.tileUrl ??
    x.TilesUrl ??
    x.tilesUrl;

  let width;
  let height;

  const size = x.Size ?? x.size;

  if (size && typeof size === "object") {
    width = Number(size.Width ?? size.width);
    height = Number(size.Height ?? size.height);
  }

  if (!width) width = Number(x.Width ?? x.width);
  if (!height) height = Number(x.Height ?? x.height);

  const tileSize = Number(
    x.TileSize ??
    x.tileSize ??
    x.tile_size
  );

  const overlap = Number(
    x.Overlap ??
    x.overlap ??
    0
  );

  const format =
    x.Format ??
    x.format ??
    "jpg";

  if (!url || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }

  if (!isHttpUrl(url)) return null;

  return {
    url,
    width,
    height,
    tileSize: Number.isFinite(tileSize) && tileSize > 0 ? tileSize : 256,
    overlap: Number.isFinite(overlap) ? overlap : 0,
    format
  };
}

function deepZoomLevel(width, height) {
  return Math.ceil(Math.log2(Math.max(width, height)));
}

function tileCount(size, tileSize) {
  return Math.ceil(size / tileSize);
}

function makeTileUrl(base, level, x, y, format) {
  let root = base;

  if (!root.endsWith("/")) root += "/";

  return `${root}${level}/${x}_${y}.${format}`;
}

async function downloadTile(context, url) {
  const response = await context.request.get(url);

  if (!response.ok()) {
    throw new Error(`Tile HTTP ${response.status()}`);
  }

  return await response.body();
}

async function assembleDeepZoom(source, context) {
  const {
    url,
    width,
    height,
    tileSize,
    format
  } = source;

  const level = deepZoomLevel(width, height);

  const scale = Math.pow(
    2,
    level - Math.ceil(Math.log2(Math.max(width, height)))
  );

  const levelWidth = Math.ceil(width * scale);
  const levelHeight = Math.ceil(height * scale);

  const cols = tileCount(levelWidth, tileSize);
  const rows = tileCount(levelHeight, tileSize);

  if (cols * rows > 10000) {
    throw new Error(
      `最高层需要 ${cols * rows} 张瓦片，数量过大，已停止。`
    );
  }

  const tiles = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const tileUrl = makeTileUrl(
        url,
        level,
        x,
        y,
        format
      );

      tiles.push({
        x,
        y,
        url: tileUrl
      });
    }
  }

  const canvas = sharp({
    create: {
      width: levelWidth,
      height: levelHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  });

  const composites = [];

  for (const tile of tiles) {
    const buffer = await downloadTile(
      context,
      tile.url
    );

    const metadata = await sharp(buffer).metadata();

    composites.push({
      input: buffer,
      left: tile.x * tileSize,
      top: tile.y * tileSize,
      blend: "over"
    });

    if (!metadata.width || !metadata.height) {
      throw new Error("无法读取瓦片尺寸");
    }
  }

  return await canvas
    .composite(composites)
    .jpeg({
      quality: 95,
      chromaSubsampling: "4:4:4"
    })
    .toBuffer();
}

app.post("/api/analyze", async (req, res) => {
  const input = String(req.body?.url || "").trim();

  if (!isHttpUrl(input)) {
    return res.status(400).json({
      error: "请输入完整的网址。"
    });
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const context = await browser.newContext({
      viewport: {
        width: 1440,
        height: 1000
      },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
    });

    const page = await context.newPage();

    const networkUrls = [];

    page.on("request", request => {
      const u = request.url();

      if (
        u.includes("image-bundle") ||
        u.includes(".dzi") ||
        u.includes("zoom") ||
        u.includes("_")
      ) {
        networkUrls.push(u);
      }
    });

    await page.goto(input, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(8000);

    const candidates = await page.evaluate(() => {
      function isCandidate(x) {
        if (!x || typeof x !== "object") return false;

        const keys = Object.keys(x).map(k =>
          k.toLowerCase()
        );

        return (
          keys.includes("url") &&
          (
            keys.includes("tilesize") ||
            keys.includes("size")
          )
        );
      }

      const found = [];
      const seen = new WeakSet();

      function walk(value, path, depth) {
        if (!value || typeof value !== "object") return;
        if (depth > 7) return;

        if (seen.has(value)) return;
        seen.add(value);

        try {
          if (isCandidate(value)) {
            const copy = {};

            for (const key of Object.keys(value)) {
              const v = value[key];

              if (
                typeof v === "string" ||
                typeof v === "number" ||
                typeof v === "boolean"
              ) {
                copy[key] = v;
              } else if (
                v &&
                typeof v === "object" &&
                !Array.isArray(v)
              ) {
                const sub = {};

                for (const k of Object.keys(v)) {
                  const sv = v[k];

                  if (
                    typeof sv === "string" ||
                    typeof sv === "number"
                  ) {
                    sub[k] = sv;
                  }
                }

                copy[key] = sub;
              }
            }

            found.push({
              path,
              value: copy
            });
          }
        } catch {}

        let keys;

        try {
          keys = Object.keys(value);
        } catch {
          return;
        }

        for (const key of keys.slice(0, 500)) {
          let child;

          try {
            child = value[key];
          } catch {
            continue;
          }

          if (
            child &&
            typeof child === "object"
          ) {
            walk(
              child,
              `${path}.${key}`,
              depth + 1
            );
          }
        }
      }

      walk(window, "window", 0);

      return found;
    });

    const normalized = [];

    for (const item of candidates) {
      const source = normalizeSource(item.value);

      if (source) {
        normalized.push({
          path: item.path,
          source
        });
      }
    }

    if (!normalized.length) {
      return res.json({
        ok: false,
        message:
          "页面已经打开，但没有找到可识别的 Deep Zoom 参数。",
        network: networkUrls.slice(0, 100)
      });
    }

    normalized.sort(
      (a, b) =>
        b.source.width * b.source.height -
        a.source.width * a.source.height
    );

    const best = normalized[0];

    return res.json({
      ok: true,
      source: best.source,
      path: best.path,
      candidates: normalized.slice(0, 10),
      network: networkUrls.slice(0, 100)
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message || String(err)
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.post("/api/download", async (req, res) => {
  const source = req.body?.source;

  if (!source || !source.url) {
    return res.status(400).json({
      error: "没有可下载的图像源。"
    });
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const context = await browser.newContext();

    const buffer = await assembleDeepZoom(
      source,
      context
    );

    res.setHeader(
      "Content-Type",
      "image/jpeg"
    );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="dpm-full.jpg"'
    );

    res.send(buffer);

  } catch (err) {
    res.status(500).json({
      error: err.message || String(err)
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});
