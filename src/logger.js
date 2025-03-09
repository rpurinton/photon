// File: logger.js

"use strict";
const fs = require("fs");
const path = require("path");

// Adjust these paths as necessary.
const LOG_DIR = "/var/log/photon";
const ACCESS_LOG = path.join(LOG_DIR, "access_log");
const ERROR_LOG = path.join(LOG_DIR, "error_log");

// Create write streams for the logs.
const accessLogStream = fs.createWriteStream(ACCESS_LOG, { flags: "a" });
const errorLogStream = fs.createWriteStream(ERROR_LOG, { flags: "a" });

function logAccess(entry) {
    accessLogStream.write(entry + "\n");
}

function logError(entry) {
    const timeStamp = new Date().toISOString();
    const line = `[${timeStamp}] ${entry}\n`;
    errorLogStream.write(line);
    // Also output to stderr.
    console.error(`[${timeStamp}] ${entry}`);
}

module.exports = { logAccess, logError };