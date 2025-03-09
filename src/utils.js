// File: utils.js

"use strict";
const path = require("path");

// Check if any part of the path begins with a dot.
function hasDotfile(p) {
    const parts = p.split(path.sep);
    return parts.some((part) => part.startsWith("."));
}

// Safely resolve a requested path against a base directory.
// Returns the fully resolved path if it is within base and has no dotfiles.
function resolveSafe(base, requestPath) {
    try {
        let decoded = decodeURIComponent(requestPath);
        let safePath = path.normalize(decoded).replace(/^(\.\.[\/\\])+/, "");
        let fullPath = path.join(base, safePath);
        if (!fullPath.startsWith(path.resolve(base))) {
            return null;
        }
        if (hasDotfile(path.relative(base, fullPath))) {
            return null;
        }
        return fullPath;
    } catch (err) {
        // In case decodeURIComponent fails.
        return null;
    }
}

// Check whether the client Accept header prefers JSON.
function clientWantsJson(req) {
    return req.headers.accept && req.headers.accept.indexOf("application/json") !== -1;
}

// Send an error response to the client in either HTML or JSON format.
function sendError(req, res, statusCode, msg) {
    res.statusCode = statusCode;
    let body;
    if (clientWantsJson(req)) {
        res.setHeader("Content-Type", "application/json");
        body = JSON.stringify({ error: msg });
    } else {
        res.setHeader("Content-Type", "text/html");
        body = `<html><head><title>Error</title></head><body><h1>${statusCode} Error</h1><p>${msg}</p></body></html>`;
    }
    res.end(body);
}

// Format a log entry in Apache Common Log Format.
function formatAccessLog(req, status, size, startTime) {
    let remoteAddr = req.socket.remoteAddress || "-";
    let ident = "-";
    let user = "-";
    let now = new Date();
    // You could adjust the date format as needed.
    let dateStr = now.toLocaleString("en-US", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    let reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
    return `${remoteAddr} ${ident} ${user} [${dateStr}] "${reqLine}" ${status} ${size}`;
}

module.exports = { resolveSafe, clientWantsJson, sendError, formatAccessLog, hasDotfile };
