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

const RETENTION_CHECK_INTERVAL_HOURS = Math.max(
    1,
    Number(process.env.RETENTION_CHECK_INTERVAL_HOURS) || 1
);

const MAX_UPLOAD_SIZE_GB = Math.max(
    1,
    Number(process.env.MAX_UPLOAD_SIZE_GB) || 25
);

const MAX_UPLOAD_SIZE_BYTES =
    MAX_UPLOAD_SIZE_GB * 1024 * 1024 * 1024;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMP_DIR = path.join(__dirname, "temp");
const KEYS_FILE = path.join(__dirname, "keys.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

if (!fs.existsSync(KEYS_FILE)) {
    fs.writeFileSync(
        KEYS_FILE,
        JSON.stringify({ keys: [] }, null, 2)
    );
}

const db = new Database(path.join(__dirname, "cdn.db"));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    originalName TEXT,
    size INTEGER,
    mime TEXT,
    uploadedAt INTEGER,
    retentionOverride INTEGER DEFAULT NULL,
    retentionDays INTEGER DEFAULT NULL,
    storagePath TEXT DEFAULT ''
)
`);

const columns = db
    .prepare("PRAGMA table_info(files)")
    .all()
    .map(column => column.name);

if (!columns.includes("retentionOverride")) {
    db.exec(`
        ALTER TABLE files
        ADD COLUMN retentionOverride INTEGER DEFAULT NULL
    `);
}

if (!columns.includes("retentionDays")) {
    db.exec(`
        ALTER TABLE files
        ADD COLUMN retentionDays INTEGER DEFAULT NULL
    `);
}

if (!columns.includes("storagePath")) {
    db.exec(`
        ALTER TABLE files
        ADD COLUMN storagePath TEXT DEFAULT ''
    `);
}

const compress = compression();

app.use(express.json({ limit: "50mb" }));

app.use(
    express.urlencoded({
        extended: true,
        limit: "50mb"
    })
);

app.use((req, res, next) => {
    res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,DELETE,OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Range, X-Retention-Enabled, X-Retention-Days"
    );

    res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Length, Content-Range"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

app.use(
    helmet({
        crossOriginResourcePolicy: false
    })
);

app.use((req, res, next) => {
    if (/\.(mp4|mov|mkv|webm|mp3)$/i.test(req.path)) {
        return next();
    }

    compress(req, res, next);
});

function getToken(req) {
    const auth = req.headers.authorization;

    if (!auth) {
        return null;
    }

    return auth.replace(/^Bearer\s+/i, "");
}

function getKeyData(token) {
    if (token && token === OWNER_KEY) {
        return {
            owner: true
        };
    }

    try {
        const keys = JSON.parse(
            fs.readFileSync(KEYS_FILE, "utf8")
        );

        return (
            keys.keys.find(k => k.key === token) ||
            null
        );
    } catch (err) {
        console.error("[KEY ERROR]", err);
        return null;
    }
}

function requireOwner(req, res) {
    const key = getKeyData(
        getToken(req)
    );

    if (!key || !key.owner) {
        res.status(403).json({
            error: "owner authorization required"
        });

        return null;
    }

    return key;
}

function id() {
    return crypto.randomUUID();
}

function getRetentionHeaders(req) {
    const daysHeader =
        req.headers["x-retention-days"];

    if (
        daysHeader === undefined ||
        daysHeader === ""
    ) {
        return {
            override: true,
            enabled: false,
            days: null
        };
    }

    const days = Number(daysHeader);

    if (
        !Number.isInteger(days) ||
        days < 1
    ) {
        throw new Error(
            "X-Retention-Days must be a positive whole number"
        );
    }

    return {
        override: true,
        enabled: true,
        days
    };
}

function sanitizePathPart(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value
        .trim()
        .replace(/\\/g, "/")
        .split("/")
        .filter(Boolean)
        .filter(part => part !== "." && part !== "..")
        .map(part =>
            part.replace(
                /[^a-zA-Z0-9._-]/g,
                "_"
            )
        )
        .join("/");
}

function getUserIdFromKey(key) {
    if (!key || !key.userId) {
        return null;
    }

    return sanitizePathPart(
        String(key.userId)
    );
}

function getSafeUploadPath(relativePath) {
    const uploadRoot =
        path.resolve(UPLOAD_DIR);

    const resolved =
        path.resolve(
            uploadRoot,
            relativePath
        );

    if (
        !resolved.startsWith(
            uploadRoot + path.sep
        )
    ) {
        throw new Error(
            "invalid upload path"
        );
    }

    return resolved;
}

async function cleanupEmptyDirectories(
    directory
) {
    const uploadRoot =
        path.resolve(UPLOAD_DIR);

    let currentDirectory =
        path.resolve(directory);

    while (
        currentDirectory !==
        uploadRoot
    ) {
        try {
            const contents =
                await fsp.readdir(
                    currentDirectory
                );

            if (
                contents.length > 0
            ) {
                break;
            }

            await fsp.rmdir(
                currentDirectory
            );

            currentDirectory =
                path.dirname(
                    currentDirectory
                );
        } catch {
            break;
        }
    }
}

let ffmpegRunning = false;
const ffmpegQueue = [];

function runQueue() {
    if (
        ffmpegRunning ||
        ffmpegQueue.length === 0
    ) {
        return;
    }

    ffmpegRunning = true;

    const item =
        ffmpegQueue.shift();

    item.job()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
            ffmpegRunning = false;
            runQueue();
        });
}

function enqueueFFmpeg(job) {
    return new Promise(
        (resolve, reject) => {
            ffmpegQueue.push({
                job,
                resolve,
                reject
            });

            runQueue();
        }
    );
}

function convertVideoToMp4(
    input,
    output
) {
    return enqueueFFmpeg(
        () =>
            new Promise(
                (resolve, reject) => {
                    const tempOut =
                        output +
                        ".tmp.mp4";

                    const copy =
                        spawn(
                            ffmpegPath,
                            [
                                "-y",
                                "-i",
                                input,
                                "-c",
                                "copy",
                                "-movflags",
                                "+faststart",
                                tempOut
                            ]
                        );

                    let copyErr = "";

                    copy.stderr.on(
                        "data",
                        d => {
                            copyErr +=
                                d.toString();
                        }
                    );

                    copy.on(
                        "close",
                        code => {
                            if (
                                code ===
                                0
                            ) {
                                return fsp
                                    .rename(
                                        tempOut,
                                        output
                                    )
                                    .then(
                                        resolve
                                    )
                                    .catch(
                                        reject
                                    );
                            }

                            console.log(
                                "[FFMPEG] Stream copy failed, falling back to re-encode..."
                            );

                            const encode =
                                spawn(
                                    ffmpegPath,
                                    [
                                        "-y",
                                        "-i",
                                        input,
                                        "-c:v",
                                        "libx264",
                                        "-preset",
                                        "medium",
                                        "-crf",
                                        "20",
                                        "-c:a",
                                        "aac",
                                        "-b:a",
                                        "192k",
                                        "-movflags",
                                        "+faststart",
                                        tempOut
                                    ]
                                );

                            let encodeErr =
                                "";

                            encode.stderr.on(
                                "data",
                                d => {
                                    encodeErr +=
                                        d.toString();
                                }
                            );

                            encode.on(
                                "close",
                                async code => {
                                    if (
                                        code !==
                                        0
                                    ) {
                                        return reject(
                                            encodeErr ||
                                                copyErr
                                        );
                                    }

                                    try {
                                        await fsp.rename(
                                            tempOut,
                                            output
                                        );

                                        resolve();
                                    } catch (
                                        e
                                    ) {
                                        reject(
                                            e
                                        );
                                    }
                                }
                            );
                        }
                    );
                }
            )
    );
}

function convertAudioToMp3(
    input,
    output
) {
    return enqueueFFmpeg(
        () =>
            new Promise(
                (resolve, reject) => {
                    const ffmpeg =
                        spawn(
                            ffmpegPath,
                            [
                                "-y",
                                "-i",
                                input,
                                "-vn",
                                "-c:a",
                                "libmp3lame",
                                "-b:a",
                                "192k",
                                output
                            ]
                        );

                    let err = "";

                    ffmpeg.stderr.on(
                        "data",
                        d => {
                            err +=
                                d.toString();
                        }
                    );

                    ffmpeg.on(
                        "close",
                        code => {
                            if (
                                code !==
                                0
                            ) {
                                return reject(
                                    err
                                );
                            }

                            resolve();
                        }
                    );
                }
            )
    );
}

app.get(
    "/health",
    (req, res) => {
        res.status(200).json({
            status: "ok",
            uptime:
                process.uptime(),
            timestamp:
                Date.now()
        });
    }
);

app.get(
    "/health/ready",
    async (req, res) => {
        try {
            db.prepare(
                "SELECT 1"
            ).get();

            await fsp.access(
                UPLOAD_DIR,
                fs.constants.R_OK |
                    fs.constants.W_OK
            );

            res.status(200).json({
                status: "ready",
                database: "ok",
                storage: "ok"
            });
        } catch (err) {
            console.error(
                "[HEALTH] Readiness check failed:",
                err
            );

            res.status(503).json({
                status: "not_ready",
                database: "unknown",
                storage: "error"
            });
        }
    }
);

app.post(
    "/upload",
    (req, res) => {
        const key =
            getKeyData(
                getToken(req)
            );

        if (!key) {
            return res.status(401).json({
                error:
                    "unauthorized"
            });
        }

        let retention;

        try {
            retention =
                getRetentionHeaders(
                    req
                );
        } catch (err) {
            return res.status(400).json({
                error:
                    err.message
            });
        }

        if (
            retention.override &&
            !key.owner
        ) {
            return res.status(403).json({
                error:
                    "only the owner can override retention"
            });
        }

        const userId =
            getUserIdFromKey(
                key
            );

        if (
            !key.owner &&
            !userId
        ) {
            return res.status(403).json({
                error:
                    "API key is not associated with a user"
            });
        }

        const busboy =
            Busboy({
                headers:
                    req.headers,
                limits: {
                    files: 1,
                    parts: 3,
                    fileSize:
                        MAX_UPLOAD_SIZE_BYTES
                }
            });

        let tempPath =
            null;

        let requestedPath =
            "";

        let responded =
            false;

        const fail =
            async err => {
                console.error(
                    "[UPLOAD ERROR]",
                    err
                );

                try {
                    if (
                        tempPath
                    ) {
                        await fsp.unlink(
                            tempPath
                        );
                    }
                } catch {}

                if (
                    !responded
                ) {
                    responded =
                        true;

                    res.status(
                        500
                    ).json({
                        error:
                            "upload failed"
                    });
                }
            };

        busboy.on(
            "field",
            (
                fieldName,
                value
            ) => {
                if (
                    fieldName ===
                    "path"
                ) {
                    requestedPath =
                        sanitizePathPart(
                            value
                        );
                }
            }
        );

        busboy.on(
            "file",
            (
                field,
                file,
                info
            ) => {
                const originalName =
                    info.filename;

                const mimeType =
                    info.mimeType;

                let bytesReceived =
                    0;

                file.on(
                    "data",
                    chunk => {
                        bytesReceived +=
                            chunk.length;
                    }
                );

                const ext =
                    path
                        .extname(
                            originalName
                        )
                        .toLowerCase();

                const baseId =
                    id();

                tempPath =
                    path.join(
                        TEMP_DIR,
                        baseId +
                            ext
                    );

                const writeStream =
                    fs.createWriteStream(
                        tempPath
                    );

                writeStream.on(
                    "error",
                    fail
                );

                file.on(
                    "error",
                    fail
                );

                file.pipe(
                    writeStream
                );

                writeStream.on(
                    "finish",
                    async () => {
                        try {
                            const audioFormats =
                                [
                                    ".wav",
                                    ".aac",
                                    ".m4a",
                                    ".flac",
                                    ".ogg",
                                    ".wma"
                                ];

                            let finalExt =
                                ext;

                            if (
                                [
                                    ".mov",
                                    ".mkv"
                                ].includes(
                                    ext
                                )
                            ) {
                                finalExt =
                                    ".mp4";
                            }

                            if (
                                audioFormats.includes(
                                    ext
                                )
                            ) {
                                finalExt =
                                    ".mp3";
                            }

                            let relativeDirectory;

                            if (
                                key.owner
                            ) {
                                relativeDirectory =
                                    requestedPath;
                            } else {
                                relativeDirectory =
                                    path.posix.join(
                                        "unverified",
                                        "file",
                                        userId,
                                        requestedPath
                                    );
                            }

                            const relativeFilePath =
                                path.posix.join(
                                    relativeDirectory,
                                    baseId +
                                        finalExt
                                );

                            const finalPath =
                                getSafeUploadPath(
                                    relativeFilePath
                                );

                            await fsp.mkdir(
                                path.dirname(
                                    finalPath
                                ),
                                {
                                    recursive:
                                        true
                                }
                            );

                            if (
                                [
                                    ".mov",
                                    ".mkv"
                                ].includes(
                                    ext
                                )
                            ) {
                                await convertVideoToMp4(
                                    tempPath,
                                    finalPath
                                );

                                await fsp.unlink(
                                    tempPath
                                );

                                tempPath =
                                    null;
                            }

                            else if (
                                audioFormats.includes(
                                    ext
                                )
                            ) {
                                await convertAudioToMp3(
                                    tempPath,
                                    finalPath
                                );

                                await fsp.unlink(
                                    tempPath
                                );

                                tempPath =
                                    null;
                            }

                            else {
                                await fsp.rename(
                                    tempPath,
                                    finalPath
                                );

                                tempPath =
                                    null;
                            }

                            let retentionOverride =
                                null;

                            let retentionDays =
                                null;

                            if (
                                retention.override
                            ) {
                                retentionOverride =
                                    retention.enabled
                                        ? 1
                                        : 0;

                                retentionDays =
                                    retention.enabled
                                        ? retention.days
                                        : null;
                            }

                            db.prepare(`
                                INSERT INTO files
                                (
                                    id,
                                    originalName,
                                    size,
                                    mime,
                                    uploadedAt,
                                    retentionOverride,
                                    retentionDays,
                                    storagePath
                                )
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            `).run(
                                baseId,
                                originalName,
                                bytesReceived,
                                mimeType,
                                Date.now(),
                                retentionOverride,
                                retentionDays,
                                relativeFilePath
                            );

                            if (
                                !responded
                            ) {
                                responded =
                                    true;

                                res.json({
                                    success:
                                        true,

                                    filename:
                                        baseId,

                                    path:
                                        relativeFilePath,

                                    url:
                                        `${BASE_URL}/${relativeFilePath}`
                                });
                            }
                        } catch (
                            e
                        ) {
                            fail(e);
                        }
                    }
                );
            }
        );

        busboy.on(
            "error",
            fail
        );

        req.pipe(
            busboy
        );
    }
);

app.delete(
    /^\/delete\/(.+)$/,
    async (
        req,
        res
    ) => {
        const key =
            getKeyData(
                getToken(req)
            );

        if (!key) {
            return res.status(401).json({
                error:
                    "unauthorized"
            });
        }

        const filename =
            req.params[0];

        let resolved;

        try {
            resolved =
                getSafeUploadPath(
                    filename
                );
        } catch {
            return res.sendStatus(
                403
            );
        }

        try {
            await fsp.access(
                resolved
            );
        } catch {
            return res.status(404).json({
                error:
                    "file not found"
            });
        }

        try {
            await fsp.unlink(
                resolved
            );

            const fileId =
                path.parse(
                    resolved
                ).name;

            db.prepare(
                "DELETE FROM files WHERE id = ?"
            ).run(
                fileId
            );

            await cleanupEmptyDirectories(
                path.dirname(
                    resolved
                )
            );

            res.json({
                success:
                    true,

                message:
                    `File ${filename} deleted.`
            });
        } catch (
            err
        ) {
            console.error(
                "[DELETE ERROR]",
                err
            );

            res.status(500).json({
                error:
                    "delete failed"
            });
        }
    }
);

app.post(
    /^\/retention\/(.+)$/,
    express.json(),
    async (
        req,
        res
    ) => {
        const key =
            requireOwner(
                req,
                res
            );

        if (!key) {
            return;
        }

        const filename =
            req.params[0];

        const fileId =
            path.parse(
                filename
            ).name;

        const file =
            db.prepare(
                "SELECT * FROM files WHERE id = ?"
            ).get(
                fileId
            );

        if (!file) {
            return res.status(404).json({
                error:
                    "file not found"
            });
        }

        const enabled =
            req.body.enabled;

        if (
            typeof enabled !==
            "boolean"
        ) {
            return res.status(400).json({
                error:
                    "enabled must be true or false"
            });
        }

        let days =
            null;

        if (
            enabled
        ) {
            days =
                Number(
                    req.body.days
                );

            if (
                !Number.isInteger(
                    days
                ) ||
                days < 1
            ) {
                return res.status(400).json({
                    error:
                        "days must be a positive whole number"
                });
            }
        }

        db.prepare(`
            UPDATE files
            SET
                retentionOverride = ?,
                retentionDays = ?
            WHERE id = ?
        `).run(
            enabled
                ? 1
                : 0,
            days,
            fileId
        );

        res.json({
            success:
                true,

            file:
                fileId,

            retention: {
                enabled,
                days
            }
        });
    }
);

app.post(
    /^\/path\/(.+)$/,
    express.json(),
    async (
        req,
        res
    ) => {
        const key =
            requireOwner(
                req,
                res
            );

        if (!key) {
            return;
        }

        const filename =
            req.params[0];

        let oldPath;

        try {
            oldPath =
                getSafeUploadPath(
                    filename
                );
        } catch {
            return res.sendStatus(
                403
            );
        }

        const fileId =
            path.parse(
                filename
            ).name;

        const file =
            db.prepare(
                "SELECT * FROM files WHERE id = ?"
            ).get(
                fileId
            );

        if (!file) {
            return res.status(404).json({
                error:
                    "file not found"
            });
        }

        const newRelativePath =
            sanitizePathPart(
                req.body.path
            );

        if (
            !newRelativePath
        ) {
            return res.status(400).json({
                error:
                    "path is required"
            });
        }

        const extension =
            path.extname(
                filename
            );

        const finalRelativePath =
            path.posix.join(
                newRelativePath,
                fileId +
                    extension
            );

        let newPath;

        try {
            newPath =
                getSafeUploadPath(
                    finalRelativePath
                );
        } catch {
            return res.status(403).json({
                error:
                    "invalid destination path"
            });
        }

        try {
            await fsp.access(
                oldPath
            );
        } catch {
            return res.status(404).json({
                error:
                    "file not found on disk"
            });
        }

        try {
            await fsp.mkdir(
                path.dirname(
                    newPath
                ),
                {
                    recursive:
                        true
                }
            );

            await fsp.rename(
                oldPath,
                newPath
            );

            db.prepare(`
                UPDATE files
                SET storagePath = ?
                WHERE id = ?
            `).run(
                finalRelativePath,
                fileId
            );

            await cleanupEmptyDirectories(
                path.dirname(
                    oldPath
                )
            );

            res.json({
                success:
                    true,

                filename:
                    fileId,

                path:
                    finalRelativePath,

                url:
                    `${BASE_URL}/${finalRelativePath}`
            });
        } catch (
            err
        ) {
            console.error(
                "[PATH ERROR]",
                err
            );

            res.status(500).json({
                error:
                    "failed to move file"
            });
        }
    }
);

async function runRetentionCleanup() {
    console.log(
        "[RETENTION] Running cleanup."
    );

    const now =
        Date.now();

    const files =
        db.prepare(`
            SELECT
                id,
                originalName,
                uploadedAt,
                retentionDays,
                storagePath
            FROM files
            WHERE retentionDays IS NOT NULL
        `).all();

    let deleted =
        0;

    let skipped =
        0;

    for (
        const file of files
    ) {
        const expirationTime =
            file.uploadedAt +
            file.retentionDays *
                24 *
                60 *
                60 *
                1000;

        if (
            now <
            expirationTime
        ) {
            skipped++;

            continue;
        }

        try {
            if (
                file.storagePath
            ) {
                const resolved =
                    getSafeUploadPath(
                        file.storagePath
                    );

                try {
                    await fsp.unlink(
                        resolved
                    );
                } catch (
                    err
                ) {
                    if (
                        err.code !==
                        "ENOENT"
                    ) {
                        throw err;
                    }
                }

                await cleanupEmptyDirectories(
                    path.dirname(
                        resolved
                    )
                );
            }

            else {
                const matchingFiles =
                    await fsp.readdir(
                        UPLOAD_DIR
                    );

                const filesToDelete =
                    matchingFiles.filter(
                        filename =>
                            path.parse(
                                filename
                            ).name ===
                            file.id
                    );

                for (
                    const filename of
                    filesToDelete
                ) {
                    try {
                        await fsp.unlink(
                            path.join(
                                UPLOAD_DIR,
                                filename
                            )
                        );
                    } catch (
                        err
                    ) {
                        if (
                            err.code !==
                            "ENOENT"
                        ) {
                            throw err;
                        }
                    }
                }
            }

            db.prepare(
                "DELETE FROM files WHERE id = ?"
            ).run(
                file.id
            );

            deleted++;

            console.log(
                `[RETENTION] Deleted ${file.id} (${file.originalName})`
            );
        } catch (
            err
        ) {
            console.error(
                `[RETENTION] Failed to delete ${file.id}:`,
                err
            );
        }
    }

    console.log(
        `[RETENTION] Cleanup complete. Deleted: ${deleted}, skipped: ${skipped}`
    );
}

setTimeout(
    () => {
        runRetentionCleanup().catch(
            err =>
                console.error(
                    "[RETENTION] Cleanup error:",
                    err
                )
        );
    },
    10000
);

setInterval(
    () => {
        runRetentionCleanup().catch(
            err =>
                console.error(
                    "[RETENTION] Cleanup error:",
                    err
                )
        );
    },
    RETENTION_CHECK_INTERVAL_HOURS *
        60 *
        60 *
        1000
);

app.get(
    /^\/(.+)$/,
    async (
        req,
        res
    ) => {
        const requestedPath =
            req.params[0];

        let resolved;

        try {
            resolved =
                getSafeUploadPath(
                    requestedPath
                );
        } catch {
            return res.sendStatus(
                403
            );
        }

        let stat;

        try {
            stat =
                await fsp.stat(
                    resolved
                );
        } catch {
            return res
                .status(404)
                .send(
                    "Not found"
                );
        }

        const ext =
            path
                .extname(
                    resolved
                )
                .toLowerCase();

        const mime = {
            ".jpg":
                "image/jpeg",

            ".jpeg":
                "image/jpeg",

            ".png":
                "image/png",

            ".gif":
                "image/gif",

            ".webp":
                "image/webp",

            ".mp4":
                "video/mp4",

            ".webm":
                "video/webm",

            ".mp3":
                "audio/mpeg"
        };

        res.setHeader(
            "Content-Type",
            mime[ext] ||
                "application/octet-stream"
        );

        res.setHeader(
            "Content-Disposition",
            "inline"
        );

        res.setHeader(
            "Cache-Control",
            "public,max-age=31536000,immutable"
        );

        res.setHeader(
            "Accept-Ranges",
            "bytes"
        );

        const range =
            req.headers.range;

        if (
            range
        ) {
            const parts =
                range
                    .replace(
                        /bytes=/,
                        ""
                    )
                    .split("-");

            const start =
                parseInt(
                    parts[0],
                    10
                );

            const end =
                parts[1]
                    ? parseInt(
                          parts[1],
                          10
                      )
                    : stat.size -
                      1;

            if (
                Number.isNaN(
                    start
                ) ||
                Number.isNaN(
                    end
                ) ||
                start >
                    end ||
                end >=
                    stat.size
            ) {
                return res
                    .status(
                        416
                    )
                    .end();
            }

            res.writeHead(
                206,
                {
                    "Content-Range":
                        `bytes ${start}-${end}/${stat.size}`,

                    "Content-Length":
                        end -
                        start +
                        1
                }
            );

            const stream =
                fs.createReadStream(
                    resolved,
                    {
                        start,
                        end
                    }
                );

            stream.on(
                "error",
                () => {
                    if (
                        !res.headersSent
                    ) {
                        res
                            .status(
                                500
                            )
                            .end();
                    }
                }
            );

            return stream.pipe(
                res
            );
        }

        res.setHeader(
            "Content-Length",
            stat.size
        );

        const stream =
            fs.createReadStream(
                resolved
            );

        stream.on(
            "error",
            () => {
                if (
                    !res.headersSent
                ) {
                    res
                        .status(
                            500
                        )
                        .end();
                }
            }
        );

        stream.pipe(
            res
        );
    }
);

app.listen(
    PORT,
    () => {
        console.log(
            `CDN running on port ${PORT}`
        );

        console.log(
            `[CONFIG] Retention check interval: ${RETENTION_CHECK_INTERVAL_HOURS} hour(s)`
        );

        console.log(
            `[CONFIG] Max upload: ${MAX_UPLOAD_SIZE_GB} GB`
        );
    }
);
