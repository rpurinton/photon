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

module.exports = { handleRequest };