// File: router.js

"use strict";
const fs = require("fs");
const path = require("path");
const url = require("url");

const { getHomeForHost } = require("./config");
const { resolveSafe, sendError, formatAccessLog } = require("./utils");
const { searchHtaccess } = require("./htaccess");
const { executePhp } = require("./phpExecutor");
const { logAccess, logError } = require("./logger");

// Idle timeout in milliseconds.
const IDLE_TIMEOUT_MS = 55 * 1000;

// Main request handler
function handleRequest(req, res) {
    req.socket.setTimeout(IDLE_TIMEOUT_MS, () => {
        logError(`Idle timeout for ${req.socket.remoteAddress}`);
        req.destroy();
    });

    const startTime = new Date();
    const parsedUrl = url.parse(req.url);
    const reqPath = parsedUrl.pathname;

    // Get the home directory based on the Host header.
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
                // Look for index files.
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
    if (path.basename(filePath).startsWith(".")) {
        sendError(req, res, 404, "Not Found");
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".php") {
        executePhp(filePath, req, res, startTime);
    } else {
        const stream = fs.createReadStream(filePath);
        stream.on("open", () => {
            // Set a basic content type.
            if (!res.getHeader("Content-Type")) {
                if (ext === ".html" || ext === ".htm") {
                    res.setHeader("Content-Type", "text/html");
                } else if (ext === ".css") {
                    res.setHeader("Content-Type", "text/css");
                } else if (ext === ".js") {
                    res.setHeader("Content-Type", "application/javascript");
                } else {
                    res.setHeader("Content-Type", "application/octet-stream");
                }
            }
            stream.pipe(res);
        });
        stream.on("error", (err) => {
            sendError(req, res, 500, "Internal Server Error");
            logError(`Error streaming file ${filePath}: ${err}`);
        });
        stream.on("end", () => {
            logAccess(formatAccessLog(req, 200, 0, startTime));
        });
    }
}

// If a file isn’t found, check for an error document defined in .htaccess.
function processErrorDocument(req, res, statusCode, notFoundPath, base, startTime) {
    const statExists = fs.existsSync(notFoundPath) && fs.statSync(notFoundPath).isDirectory();
    const searchDir = statExists ? notFoundPath : path.dirname(notFoundPath);
    const errors = searchHtaccess(searchDir);
    const doc = errors[String(statusCode)];
    if (doc && fs.existsSync(doc)) {
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
        sendError(req, res, statusCode, "Not Found");
        logAccess(formatAccessLog(req, statusCode, 0, startTime));
    }
}

module.exports = { handleRequest };