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
    //console.log("Handling request for:", req.url);
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
        //console.log("No matching host found for:", req.headers.host);
        sendError(req, res, 404, "No matching host found");
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
        return;
    }

    const filePath = resolveSafe(home, reqPath);
    if (!filePath) {
        //console.log("File not found:", reqPath);
        sendError(req, res, 404, "Not Found");
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err) {
            //console.log("Error stating file:", filePath, err);
            processErrorDocument(req, res, 404, filePath, home, startTime);
        } else {
            if (stats.isDirectory()) {
                //console.log("Directory found, looking for index files in:", filePath);
                // Look for index files.
                const indexes = ["index.php", "index.html", "index.htm"];
                (function next(i) {
                    if (i >= indexes.length) {
                        //console.log("No index file found in directory:", filePath);
                        processErrorDocument(req, res, 404, filePath, home, startTime);
                        return;
                    }
                    const indexPath = path.join(filePath, indexes[i]);
                    fs.stat(indexPath, (err2, stats2) => {
                        if (!err2 && stats2.isFile()) {
                            //console.log("Index file found:", indexPath);
                            serveFile(indexPath, req, res, startTime);
                        } else {
                            next(i + 1);
                        }
                    });
                })(0);
            } else if (stats.isFile()) {
                //console.log("File found:", filePath);
                serveFile(filePath, req, res, startTime);
            } else {
                //console.log("Forbidden access to:", filePath);
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
            ".html": "text/html",
            ".htm": "text/html",
            ".css": "text/css",
            ".js": "application/javascript",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".ico": "image/x-icon",
            ".webp": "image/webp",
            ".woff": "application/font-woff",
            ".woff2": "application/font-woff2",
            ".ttf": "application/font-sfnt",
            ".otf": "application/font-sfnt",
            ".eot": "application/vnd.ms-fontobject"
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