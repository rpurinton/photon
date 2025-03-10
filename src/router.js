"use strict";
const fs = require("fs");
const path = require("path");
const url = require("url");

const { getHomeForHost } = require("./config");
const { resolveSafe, sendError, formatAccessLog } = require("./utils");
const { searchHtaccess } = require("./htaccess");
const { executePhp } = require("./phpExecutor");
const { logAccess, logError } = require("./logger");

const IDLE_TIMEOUT_MS = 55 * 1000;

function handleRequest(req, res) {
    req.socket.setTimeout(IDLE_TIMEOUT_MS, () => {
        req.destroy();
    });

    const startTime = new Date();
    const parsedUrl = url.parse(req.url);
    const reqPath = parsedUrl.pathname;

    const home = getHomeForHost(req.headers.host);
    if (!home) {
        sendError(req, res, 404, "No matching host found");
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
        return;
    }

    const filePath = resolveSafe(home, reqPath);
    if (!filePath) {
        sendError(req, res, 404, "Not Found");
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err) {
            processErrorDocument(req, res, 404, filePath, home, startTime);
        } else {
            if (stats.isDirectory()) {
                const indexes = ["index.php", "index.html", "index.htm"];
                (function next(i) {
                    if (i >= indexes.length) {
                        processErrorDocument(req, res, 404, filePath, home, startTime);
                        return;
                    }
                    const indexPath = path.join(filePath, indexes[i]);
                    fs.stat(indexPath, (err2, stats2) => {
                        if (!err2 && stats2.isFile()) {
                            serveFile(indexPath, req, res, startTime);
                        } else {
                            next(i + 1);
                        }
                    });
                })(0);
            } else if (stats.isFile()) {
                serveFile(filePath, req, res, startTime);
            } else {
                sendError(req, res, 403, "Forbidden");
                logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
            }
        }
    });
}

// Serve a file: if PHP, execute it; otherwise stream it.
function serveFile(filePath, req, res, startTime) {
    //console.log("Serving file:", filePath);
    if (path.basename(filePath).startsWith(".")) {
        //console.log("Hidden file, not serving:", filePath);
        sendError(req, res, 404, "Not Found");
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".php") {
        //console.log("Executing PHP file:", filePath);
        executePhp(filePath, req, res, startTime);
    } else {
        // Define a mapping object for content types.
        const contentTypeMap = {
            ".7z": "application/x-7z-compressed",
            ".aac": "audio/aac",
            ".avi": "video/x-msvideo",
            ".bat": "application/x-batch",
            ".bin": "application/octet-stream",
            ".bmp": "image/bmp",
            ".bz2": "application/x-bzip2",
            ".c": "text/x-c",
            ".cab": "application/vnd.ms-cab-compressed",
            ".csv": "text/csv",
            ".cpp": "text/x-c++src",
            ".css": "text/css",
            ".doc": "application/msword",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".dll": "application/octet-stream",
            ".eot": "application/vnd.ms-fontobject",
            ".exe": "application/octet-stream",
            ".flac": "audio/flac",
            ".flv": "video/x-flv",
            ".gif": "image/gif",
            ".htm": "text/html",
            ".html": "text/html",
            ".htc": "text/x-component",
            ".ico": "image/x-icon",
            ".ini": "text/plain",
            ".java": "text/x-java-source",
            ".jpeg": "image/jpeg",
            ".jpg": "image/jpeg",
            ".json": "application/json",
            ".js": "application/javascript",
            ".less": "text/x-less",
            ".log": "text/plain",
            ".md": "text/markdown",
            ".midi": "audio/midi",
            ".mkv": "video/x-matroska",
            ".mov": "video/quicktime",
            ".mp3": "audio/mpeg",
            ".mp4": "video/mp4",
            ".mpg": "video/mpeg",
            ".msi": "application/x-msi",
            ".ogg": "audio/ogg",
            ".opus": "audio/opus",
            ".otf": "application/font-sfnt",
            ".pdf": "application/pdf",
            ".png": "image/png",
            ".pl": "application/x-perl",
            ".py": "text/x-python",
            ".rar": "application/vnd.rar",
            ".sql": "text/x-sql",
            ".scss": "text/x-scss",
            ".sh": "application/x-sh",
            ".swf": "application/x-shockwave-flash",
            ".svg": "image/svg+xml",
            ".tar": "application/x-tar",
            ".tar.gz": "application/gzip",
            ".tgz": "application/gzip",
            ".ts": "video/mp2t",
            ".txt": "text/plain",
            ".webmanifest": "application/manifest+json",
            ".webm": "video/webm",
            ".webp": "image/webp",
            ".woff": "application/font-woff",
            ".woff2": "application/font-woff2",
            ".xhtml": "application/xhtml+xml",
            ".xml": "application/xml",
            ".yaml": "application/x-yaml",
            ".yml": "application/x-yaml",
            ".zip": "application/zip"
        };

        //console.log("Streaming file:", filePath);
        const stream = fs.createReadStream(filePath);
        stream.on("open", () => {
            // Set content type using the mapping.
            if (!res.getHeader("Content-Type")) {
                res.setHeader("Content-Type", contentTypeMap[ext] || "application/octet-stream");
            }
            // Force connection close after response.
            res.setHeader("Connection", "close");
            stream.pipe(res);
        });
        stream.on("error", (err) => {
            //console.log("Error streaming file:", filePath, err);
            sendError(req, res, 500, "Internal Server Error");
            logError(`Error streaming file ${filePath}: ${err}`);
        });
        stream.on("end", () => {
            //console.log("File stream ended:", filePath);
            logAccess(formatAccessLog(req, 200, 0, startTime));
        });
    }
}

// If a file isn’t found, check for an error document defined in .htaccess.
function processErrorDocument(req, res, statusCode, notFoundPath, base, startTime) {
    //console.log("Processing error document for status code:", statusCode);
    const statExists = fs.existsSync(notFoundPath) && fs.statSync(notFoundPath).isDirectory();
    const searchDir = statExists ? notFoundPath : path.dirname(notFoundPath);
    const errors = searchHtaccess(searchDir);
    const doc = errors[String(statusCode)];
    if (doc && fs.existsSync(doc)) {
        //console.log("Error document found:", doc);
        const ext = path.extname(doc).toLowerCase();
        if (ext === ".php") {
            executePhp(doc, req, res, startTime);
        } else {
            const stream = fs.createReadStream(doc);
            if (ext === ".html" || ext === ".htm") {
                res.setHeader("Content-Type", "text/html");
            }
            stream.pipe(res);
            stream.on("end", () => {
                logAccess(formatAccessLog(req, statusCode, 0, startTime));
            });
        }
    } else {
        //console.log("No error document found, sending default error response.");
        sendError(req, res, statusCode, "Not Found");
        logAccess(formatAccessLog(req, statusCode, 0, startTime));
    }
}

module.exports = { handleRequest };