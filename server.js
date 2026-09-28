import express from "express";
import sharp from "sharp";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;
const JOB_DIR = path.resolve("./jobs");

fs.mkdirSync(JOB_DIR, { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const jobs = new Map();

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function updateJob(id, data) {
  jobs.set(id, {
    ...(jobs.get(id) || {}),
    ...data
  });
}

async function getBuffer(url) {
  const response = await fetch(url, {
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

async function getText(url) {
  const response = await fetch(url, {
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return await response.text();
}

function parseDzi(xml) {
  const imageTag =
    xml.match(/<Image\b[^>]*>/i)?.[0] || "";

  const sizeTag =
    xml.match(/<Size\b[^>]*>/i)?.[0] || "";

  function attr(tag, name) {
    const re = new RegExp(
      `\\b${name}\\s*=\\s*["']([^"']+)["']`,
      "i"
    );

    return tag.match(re)?.[1];
  }

  const width =
    Number(attr(sizeTag, "Width"));

  const height =
    Number(attr(sizeTag, "Height"));

  const tileSize =
    Number(attr(imageTag, "TileSize")) || 256;

  const overlap =
    Number(attr(imageTag, "Overlap")) || 0;

  const format =
    attr(imageTag, "Format") || "jpg";

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    throw new Error(
      "无法从 DZI 找到 Width / Height"
    );
  }

  return {
    width,
    height,
    tileSize,
    overlap,
    format
  };
}

function getMaxLevel(width, height) {
  return Math.ceil(
    Math.log2(
      Math.max(width, height)
    )
  );
}

function levelSize(width, height, level) {
  const maxLevel =
    getMaxLevel(width, height);

  const scale =
    Math.pow(
      2,
      maxLevel - level
    );

  return {
    width: Math.ceil(width / scale),
    height: Math.ceil(height / scale)
  };
}

function makeTileUrl(
  dziUrl,
  level,
  x,
  y,
  format
) {
  const u =
    new URL(dziUrl);

  const base =
    u.pathname.replace(
      /\.dzi$/i,
      ""
    );

  u.pathname =
    `${base}_files/${level}/${x}_${y}.${format}`;

  return u.toString();
}

async function prepareTile(
  buffer,
  x,
  y,
  level,
  metadata
) {
  const {
    width,
    height,
    tileSize,
    overlap
  } = metadata;

  const size =
    levelSize(
      width,
      height,
      level
    );

  const columns =
    Math.ceil(
      size.width /
      tileSize
    );

  const rows =
    Math.ceil(
      size.height /
      tileSize
    );

  const left =
    x === 0 ? 0 : overlap;

  const top =
    y === 0 ? 0 : overlap;

  const right =
    x === columns - 1
      ? 0
      : overlap;

  const bottom =
    y === rows - 1
      ? 0
      : overlap;

  const image =
    sharp(buffer);

  const info =
    await image.metadata();

  const actualWidth =
    info.width || tileSize;

  const actualHeight =
    info.height || tileSize;

  const cropWidth =
    Math.max(
      1,
      actualWidth -
      left -
      right
    );

  const cropHeight =
    Math.max(
      1,
      actualHeight -
      top -
      bottom
    );

  const output =
    await image
      .extract({
        left,
        top,
        width: cropWidth,
        height: cropHeight
      })
      .png()
      .toBuffer();

  return {
    buffer: output,
    left:
      x * tileSize + left,
    top:
      y * tileSize + top
  };
}

app.post(
  "/api/jobs",
  async (req, res) => {
    const dzi =
      String(
        req.body?.dzi || ""
      ).trim();

    if (
      !/^https?:\/\//i.test(dzi)
    ) {
      return res
        .status(400)
        .json({
          error:
            "请输入完整的 HTTP/HTTPS DZI 地址"
        });
    }

    const id =
      makeId();

    jobs.set(id, {
      status: "starting",
      progress: 0,
      message:
        "准备开始……"
    });

    res.json({ id });

    runJob(id, dzi)
      .catch(error => {
        console.error(error);

        updateJob(id, {
          status: "error",
          message:
            error.message ||
            String(error)
        });
      });
  }
);

app.get(
  "/api/jobs/:id",
  (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            "任务不存在"
        });
    }

    res.json(job);
  }
);

app.get(
  "/api/jobs/:id/download",
  (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (
      !job ||
      job.status !== "done" ||
      !job.output
    ) {
      return res
        .status(404)
        .send(
          "文件尚未生成"
        );
    }

    res.download(
      job.output,
      "deepzoom-full.png"
    );
  }
);

async function runJob(
  id,
  dziUrl
) {
  updateJob(id, {
    status: "reading",
    progress: 2,
    message:
      "正在读取 DZI……"
  });

  const xml =
    await getText(dziUrl);

  const metadata =
    parseDzi(xml);

  const {
    width,
    height,
    tileSize,
    format
  } = metadata;

  const level =
    getMaxLevel(
      width,
      height
    );

  const finalSize =
    levelSize(
      width,
      height,
      level
    );

  const columns =
    Math.ceil(
      finalSize.width /
      tileSize
    );

  const rows =
    Math.ceil(
      finalSize.height /
      tileSize
    );

  const total =
    columns * rows;

  updateJob(id, {
    status: "downloading",
    progress: 5,
    message:
      `原图：${width} × ${height}\n` +
      `最高 Level：${level}\n` +
      `瓦片：${columns} × ${rows}\n` +
      `共 ${total} 张`
  });

  const jobDir =
    path.join(
      JOB_DIR,
      id
    );

  fs.mkdirSync(
    jobDir,
    { recursive: true }
  );

  const pieces = [];

  let completed = 0;

  const BATCH = 100;

  for (
    let start = 0;
    start < total;
    start += BATCH
  ) {
    const end =
      Math.min(
        total,
        start + BATCH
      );

    const composites = [];

    for (
      let index = start;
      index < end;
      index++
    ) {
      const x =
        index % columns;

      const y =
        Math.floor(
          index / columns
        );

      const url =
        makeTileUrl(
          dziUrl,
          level,
          x,
          y,
          format
        );

      try {
        const buffer =
          await getBuffer(url);

        const tile =
          await prepareTile(
            buffer,
            x,
            y,
            level,
            metadata
          );

        composites.push(tile);
      } catch (error) {
        console.warn(
          "瓦片失败:",
          x,
          y,
          error.message
        );
      }

      completed++;

      updateJob(id, {
        progress:
          5 +
          Math.floor(
            (completed / total) *
            75
          ),
        message:
          `正在下载瓦片……\n` +
          `${completed} / ${total}`
      });
    }

    if (composites.length) {
      const piece =
        path.join(
          jobDir,
          `piece-${start}.png`
        );

      await sharp({
        create: {
          width:
            finalSize.width,
          height:
            finalSize.height,
          channels: 4,
          background: {
            r: 0,
            g: 0,
            b: 0,
            alpha: 0
          }
        }
      })
        .composite(
          composites.map(
            x => ({
              input: x.buffer,
              left: x.left,
              top: x.top
            })
          )
        )
        .png()
        .toFile(piece);

      pieces.push(piece);
    }
  }

  updateJob(id, {
    status: "merging",
    progress: 85,
    message:
      "正在生成最终高清图……"
  });

  const output =
    path.join(
      jobDir,
      "full.png"
    );

  await sharp({
    create: {
      width:
        finalSize.width,
      height:
        finalSize.height,
      channels: 4,
      background: {
        r: 255,
        g: 255,
        b: 255,
        alpha: 1
      }
    }
  })
    .composite(
      pieces.map(
        piece => ({
          input: piece,
          left: 0,
          top: 0
        })
      )
    )
    .png({
      compressionLevel: 6
    })
    .toFile(output);

  updateJob(id, {
    status: "done",
    progress: 100,
    message:
      `完成！\n` +
      `最终尺寸：${finalSize.width} × ${finalSize.height}`,
    output
  });
}

app.listen(
  PORT,
  () => {
    console.log(
      `DZI 拼图器运行于 http://localhost:${PORT}`
    );
  }
);
