import express from "express";
import sharp from "sharp";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const jobs = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanUrl(value) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) {
      throw new Error("只支持 http/https 地址");
    }
    return u.toString();
  } catch {
    throw new Error("网址格式不正确");
  }
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*"
    }
  });

  if (!r.ok) {
    throw new Error(`读取失败 HTTP ${r.status}`);
  }

  return await r.json();
}

/*
  支持：
  1. 直接输入 IIIF info.json
  2. 输入 IIIF 图片服务基础地址
*/
async function getInfo(input) {
  let url = cleanUrl(input);

  if (!url.endsWith("/info.json")) {
    url = url.replace(/\/+$/, "") + "/info.json";
  }

  const info = await fetchJson(url);

  if (!info.width || !info.height) {
    throw new Error("这个地址不是有效的 IIIF info.json");
  }

  return {
    info,
    infoUrl: url,
    baseUrl: url.slice(0, -"/info.json".length)
  };
}

function chooseTileLevel(info) {
  if (!Array.isArray(info.tiles) || !info.tiles.length) {
    return null;
  }

  const tile = info.tiles[0];

  if (!Array.isArray(tile.scaleFactors) || !tile.scaleFactors.length) {
    return null;
  }

  // scaleFactor 越小，分辨率越高。
  return {
    width: tile.width,
    height: tile.height || tile.width,
    scaleFactor: Math.min(...tile.scaleFactors)
  };
}

function iiifTileUrl(base, x, y, w, h, scale) {
  const rx = x * scale;
  const ry = y * scale;

  const rw = Math.min(w * scale, 1000000000);
  const rh = Math.min(h * scale, 1000000000);

  return `${base}/${rx},${ry},${rw},${rh}/${w},${h}/0/default.jpg`;
}

async function downloadBuffer(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "image/avif,image/webp,image/jpeg,image/png,*/*"
    }
  });

  if (!r.ok) {
    throw new Error(`图片读取失败 HTTP ${r.status}`);
  }

  return Buffer.from(await r.arrayBuffer());
}

async function makeImage(input, job) {
  const { info, baseUrl } = await getInfo(input);

  job.status = "读取图像信息";
  job.width = info.width;
  job.height = info.height;

  const tileInfo = chooseTileLevel(info);

  /*
    如果服务器允许直接请求 full，
    优先尝试完整图。
  */
  const fullUrl =
    `${baseUrl}/full/full/0/default.jpg`;

  try {
    job.status = "尝试获取完整原图";
    const full = await downloadBuffer(fullUrl);

    const meta = await sharp(full).metadata();

    if (meta.width && meta.height) {
      job.status = "完成";
      job.progress = 100;

      return full;
    }
  } catch {
    // 完整图不可直接获取，继续走瓦片方式
  }

  if (!tileInfo) {
    throw new Error(
      "服务器没有提供可识别的 IIIF 瓦片信息，也无法直接取得完整图。"
    );
  }

  const tw = tileInfo.width;
  const th = tileInfo.height;
  const scale = tileInfo.scaleFactor;

  const cols = Math.ceil(info.width / (tw * scale));
  const rows = Math.ceil(info.height / (th * scale));

  job.status = `开始拼接 ${cols} × ${rows} 个最高级瓦片`;
  job.total = cols * rows;
  job.done = 0;

  /*
    为了避免手机/服务器一次性占用巨量内存，
    先把瓦片保存成临时 PNG，再合成。
  */
  const pieces = [];

  for (let y = 0; y < rows; y++) {
    const row = [];

    for (let x = 0; x < cols; x++) {
      const remainingW = info.width - x * tw * scale;
      const remainingH = info.height - y * th * scale;

      const outW = Math.min(tw, Math.ceil(remainingW / scale));
      const outH = Math.min(th, Math.ceil(remainingH / scale));

      const url = iiifTileUrl(
        baseUrl,
        x,
        y,
        outW,
        outH,
        scale
      );

      const buf = await downloadBuffer(url);

      const resized = await sharp(buf)
        .resize(outW, outH, {
          fit: "fill"
        })
        .png()
        .toBuffer();

      row.push({
        input: resized,
        left: x * tw,
        top: y * th
      });

      job.done++;
      job.progress = Math.round(
        (job.done / job.total) * 100
      );

      job.status =
        `正在拼接：${job.done}/${job.total}`;

      await sleep(10);
    }

    pieces.push(row);
  }

  const composite = [];

  for (const row of pieces) {
    for (const p of row) {
      composite.push({
        input: p.input,
        left: p.left,
        top: p.top
      });
    }
  }

  const output = await sharp({
    create: {
      width: info.width,
      height: info.height,
      channels: 3,
      background: {
        r: 255,
        g: 255,
        b: 255
      }
    }
  })
    .composite(composite)
    .jpeg({
      quality: 95,
      chromaSubsampling: "4:4:4"
    })
    .toBuffer();

  job.status = "完成";
  job.progress = 100;

  return output;
}

app.post("/api/start", async (req, res) => {
  try {
    const input = String(req.body?.url || "").trim();

    if (!input) {
      return res.status(400).json({
        error: "请输入图片服务地址"
      });
    }

    const id =
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);

    jobs.set(id, {
      status: "准备开始",
      progress: 0,
      done: 0,
      total: 0,
      buffer: null,
      error: null
    });

    res.json({ id });

    const job = jobs.get(id);

    try {
      job.buffer = await makeImage(input, job);
    } catch (err) {
      job.error = err.message || String(err);
      job.status = "失败";
    }
  } catch (err) {
    res.status(500).json({
      error: err.message || String(err)
    });
  }
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "任务不存在"
    });
  }

  res.json({
    status: job.status,
    progress: job.progress,
    done: job.done,
    total: job.total,
    error: job.error,
    ready: !!job.buffer
  });
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || !job.buffer) {
    return res.status(404).send("文件还没有准备好");
  }

  res.setHeader(
    "Content-Type",
    "image/jpeg"
  );

  res.setHeader(
    "Content-Disposition",
    'attachment; filename="full-resolution.jpg"'
  );

  res.send(job.buffer);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
