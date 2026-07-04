require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const Busboy = require("busboy");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const Database = require("better-sqlite3");

const app = express();

const PORT = process.env.PORT || 3010;
const BASE_URL = process.env.BASE_URL;
const OWNER_KEY = process.env.OWNER_API_KEY;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMP_DIR = path.join(__dirname, "temp");
const KEYS_FILE = path.join(__dirname, "keys.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

if (!fs.existsSync(KEYS_FILE)) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys: [] }, null, 2));
}

const db = new Database(path.join(__dirname, "cdn.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    originalName TEXT,
    size INTEGER,
    mime TEXT,
    uploadedAt INTEGER
)
`);

const compress = compression();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

app.use(helmet({ crossOriginResourcePolicy: false }));

app.use((req, res, next) => {
    if (/\.(mp4|mov|webm)$/i.test(req.path)) return next();
    compress(req, res, next);
});

function getToken(req) {
    const auth = req.headers.authorization;
    return auth ? auth.replace("Bearer ", "") : null;
}

function getKeyData(token) {
    if (token === OWNER_KEY) return { owner: true };
    const keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
    return keys.keys.find(k => k.key === token) || null;
}

function id() {
    return crypto.randomUUID();
}

let ffmpegRunning = false;
const ffmpegQueue = [];

function runQueue() {
    if (ffmpegRunning || ffmpegQueue.length === 0) return;

    ffmpegRunning = true;

    const item = ffmpegQueue.shift();

    item.job()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
            ffmpegRunning = false;
            runQueue();
        });
}

function enqueueFFmpeg(job) {
    return new Promise((resolve, reject) => {
        ffmpegQueue.push({ job, resolve, reject });
        runQueue();
    });
}

function convertMovToMp4(input, output) {
    return enqueueFFmpeg(() =>
        new Promise((resolve, reject) => {
            const tempOut = output + ".tmp.mp4";

            const ffmpeg = spawn(ffmpegPath, [
                "-y",
                "-i", input,
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "30",
                "-threads", "1",
                "-c:a", "aac",
                "-b:a", "96k",
                "-movflags", "+faststart",
                tempOut
            ]);

            let err = "";

            ffmpeg.stderr.on("data", d => {
                err += d.toString();
            });

            ffmpeg.on("close", async code => {
                if (code !== 0) return reject(err);

                await fsp.rename(tempOut, output);
                resolve();
            });
        })
    );
}

app.post("/upload", (req, res) => {
    const key = getKeyData(getToken(req));
    if (!key) return res.status(401).json({ error: "unauthorized" });

    const busboy = Busboy({
        headers: req.headers,
        limits: {
            files: 1,
            parts: 2,
            fileSize: 25 * 1024 * 1024 * 1024
        }
    });

    let tempPath = null;
    let responded = false;

    const fail = async (err) => {
        console.error("[UPLOAD ERROR]", err);

        try {
            if (tempPath) await fsp.unlink(tempPath);
        } catch {}

        if (!responded) {
            responded = true;
            res.status(500).json({ error: "upload failed" });
        }
    };

    busboy.on("file", (field, file, info) => {
        const originalName = info.filename;
        const mimeType = info.mimeType;

        let bytesReceived = 0;

        file.on("data", chunk => {
            bytesReceived += chunk.length;
        });

        const ext = path.extname(originalName).toLowerCase();
        const baseId = id();

        tempPath = path.join(TEMP_DIR, baseId + ext);

        const writeStream = fs.createWriteStream(tempPath);

        writeStream.on("error", fail);
        file.on("error", fail);

        file.pipe(writeStream);

        writeStream.on("finish", async () => {
            try {
                const finalExt = ext === ".mov" ? ".mp4" : ext;
                const finalPath = path.join(UPLOAD_DIR, baseId + finalExt);

                if (ext === ".mov") {
                    await convertMovToMp4(tempPath, finalPath);
                    await fsp.unlink(tempPath);
                } else {
                    await fsp.rename(tempPath, finalPath);
                }

                db.prepare(`
                    INSERT INTO files
                    (id, originalName, size, mime, uploadedAt)
                    VALUES (?, ?, ?, ?, ?)
                `).run(
                    baseId,
                    originalName,
                    bytesReceived,
                    mimeType,
                    Date.now()
                );

                if (!responded) {
                    responded = true;

                    res.json({
                        success: true,
                        filename: baseId,
                        url: `${BASE_URL}/${baseId}${finalExt}`
                    });
                }
            } catch (e) {
                fail(e);
            }
        });
    });

    busboy.on("error", fail);

    req.pipe(busboy);
});

app.get("/:file", async (req, res) => {
    const resolved = path.resolve(UPLOAD_DIR, req.params.file);

    if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) {
        return res.sendStatus(403);
    }

    let stat;

    try {
        stat = await fsp.stat(resolved);
    } catch {
        return res.status(404).send("Not found");
    }

    const ext = path.extname(resolved).toLowerCase();

    const mime = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".webm": "video/webm"
    };

    res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "public,max-age=31536000,immutable");
    res.setHeader("Accept-Ranges", "bytes");

    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");

        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

        if (
            Number.isNaN(start) ||
            Number.isNaN(end) ||
            start > end ||
            end >= stat.size
        ) {
            return res.status(416).end();
        }

        res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Content-Length": end - start + 1
        });

        const stream = fs.createReadStream(resolved, { start, end });

        stream.on("error", () => {
            if (!res.headersSent) res.status(500).end();
        });

        return stream.pipe(res);
    }

    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(resolved);

    stream.on("error", () => {
        if (!res.headersSent) res.status(500).end();
    });

    stream.pipe(res);
});

app.listen(PORT, () => {
    console.log(`CDN running on port ${PORT}`);
});