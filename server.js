import express from "express";
import sharp from "sharp";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const jobs = new Map();

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function validHttpUrl(value) {
  const u = new URL(value);

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("只允许 http 或 https 地址");
  }

  return u;
}

async function readResponse(response) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `服务器返回 HTTP ${response.status}\n${text.slice(0, 300)}`
    );
  }

  return text;
}

/*
 * 读取 IIIF info.json
 */
async function getIIIFInfo(input) {
  const u = validHttpUrl(input);

  let infoUrl = u.toString();

  if (!infoUrl.endsWith("/info.json")) {
    infoUrl = infoUrl.replace(/\/+$/, "") + "/info.json";
  }

  const response = await fetch(infoUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const text = await readResponse(response);

  let info;

  try {
    info = JSON.parse(text);
  } catch {
    throw new Error(
      "这个地址返回的不是 IIIF info.json。\n\n" +
      "返回内容开头：\n" +
      text.slice(0, 300)
    );
  }

  if (!info.width || !info.height) {
    throw new Error("没有找到图像 Width / Height");
  }

  return {
    info,
    infoUrl
  };
}

/*
 * 从 IIIF info.json 得到图像服务根地址
 */
function getBaseUrl(infoUrl) {
  return infoUrl.replace(/\/info\.json.*$/, "");
}

/*
 * 生成 IIIF full 图片地址
 */
function fullImageUrl(baseUrl) {
  return `${baseUrl}/full/max/0/default.jpg`;
}

/*
 * 尝试获取完整图片
 */
async function tryFullImage(baseUrl) {
  const url = fullImageUrl(baseUrl);

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "image/jpeg,image/png,image/*"
    }
  });

  if (!response.ok) {
    throw new Error(`完整图 HTTP ${response.status}`);
  }

  const type = response.headers.get("content-type") || "";

  if (!type.startsWith("image/")) {
    throw new Error("服务器没有返回图片");
  }

  return Buffer.from(await response.arrayBuffer());
}

async function generate(job, input) {
  job.status = "正在读取图像信息";
  job.progress = 5;

  const { info, infoUrl } = await getIIIFInfo(input);

  job.width = info.width;
  job.height = info.height;

  /*
   * 先尝试 IIIF 原图接口。
   */
  try {
    job.status = "正在获取完整图像";
    job.progress = 20;

    const image = await tryFullImage(getBaseUrl(infoUrl));

    const metadata = await sharp(image).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error("返回内容不是有效图像");
    }

    job.buffer = image;
    job.progress = 100;
    job.status = "完成";

    return;
  } catch {
    /*
     * 这里不再假装 IIIF 一定可以拼。
     * 如果没有直接原图，告诉用户实际原因。
     */
  }

  if (!info.tiles || !info.tiles.length) {
    throw new Error(
      "这个 IIIF 服务没有提供可识别的瓦片信息，也无法直接获取完整图像。"
    );
  }

  throw new Error(
    "检测到了 IIIF 图像服务，但当前服务不允许直接取得完整原图。"
  );
}

/*
 * 创建任务
 */
app.post("/api/start", async (req, res) => {
  try {
    const input = String(req.body?.url || "").trim();

    if (!input) {
      return res.status(400).json({
        ok: false,
        error: "请输入地址"
      });
    }

    validHttpUrl(input);

    const id = makeId();

    const job = {
      id,
      status: "等待开始",
      progress: 0,
      width: 0,
      height: 0,
      buffer: null,
      error: null
    };

    jobs.set(id, job);

    res.json({
      ok: true,
      id
    });

    generate(job, input).catch(error => {
      job.status = "失败";
      job.error = error.message || String(error);
    });

  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message || String(error)
    });
  }
});

/*
 * 查询任务
 */
app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "任务不存在"
    });
  }

  res.json({
    ok: true,
    status: job.status,
    progress: job.progress,
    width: job.width,
    height: job.height,
    error: job.error,
    ready: !!job.buffer
  });
});

/*
 * 下载结果
 */
app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || !job.buffer) {
    return res.status(404).send("文件还没有生成");
  }

  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="full-resolution.jpg"'
  );

  res.send(job.buffer);
});

/*
 * 防止未知 API 被 Express 返回 HTML，
 * 统一返回 JSON。
 */
app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "API 地址不存在"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
