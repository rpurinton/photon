/* photon.js – A first-draft Photon server in Node.js */

"use strict";

const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// CONSTANTS
const PORT = 80;
const PHP_BIN = "/usr/bin/php";
const IDLE_TIMEOUT_MS = 55 * 1000;
const CONFIG_PATH = path.join(__dirname, "Config.json");
const LOG_DIR = "/var/log/photon";
const ACCESS_LOG = path.join(LOG_DIR, "access_log");
const ERROR_LOG = path.join(LOG_DIR, "error_log");

// Global configuration variable (reloaded on SIGHUP)
let config;

// Load configuration JSON from file
function loadConfig() {
    try {
        let data = fs.readFileSync(CONFIG_PATH, "utf8");
        config = JSON.parse(data);
        logError(`Config loaded: ${CONFIG_PATH}`);
    } catch (err) {
        logError(`Error loading config: ${err}`);
        process.exit(1);
    }
}

// Logging functions

const accessLogStream = fs.createWriteStream(ACCESS_LOG, { flags: "a" });
const errorLogStream = fs.createWriteStream(ERROR_LOG, { flags: "a" });

function logAccess(entry) {
    accessLogStream.write(entry + "\n");
}

function logError(entry) {
    // prepend timestamp
    const timeStamp = new Date().toISOString();
    errorLogStream.write(`[${timeStamp}] ${entry}\n`);
    // also echo to stderr
    console.error(`[${timeStamp}] ${entry}`);
}

// Signal handling for graceful shutdown and config reload
process.on("SIGTERM", () => {
    logError("Received SIGTERM, shutting down gracefully.");
    server.close(() => {
        process.exit(0);
    });
});

process.on("SIGHUP", () => {
    logError("Received SIGHUP, reloading configuration.");
    loadConfig();
});

// Helper: match host against configured domains (support wildcards)
// config.domains is assumed to be an array of objects:
// { "domain": "example.com" or "*.example.com", "home": "/path/to/home" }
function getHomeForHost(host) {
    if (!host) return null;
    host = host.split(":")[0].toLowerCase();  // remove port if present
    for (let entry of config.domains) {
        let domain = entry.domain.toLowerCase();
        if (domain.startsWith("*.")) {
            // wildcard: strip "*." and check if host ends with that
            let suffix = domain.substring(2);
            if (host === suffix || host.endsWith("." + suffix)) {
                return entry.home;
            }
        } else {
            if (host === domain) return entry.home;
        }
    }
    return null;
}

// Helper: disallow any dotfiles in the path (e.g. .htaccess, .git, etc.)
function hasDotfile(p) {
    let parts = p.split(path.sep);
    return parts.some(part => part.startsWith("."));
}

// Helper: safely resolve file inside the home directory
function resolveSafe(base, requestPath) {
    // Normalize the url path and remove query parameters.
    let decoded = decodeURIComponent(requestPath);
    let safePath = path.normalize(decoded).replace(/^(\.\.[\/\\])+/, "");
    let fullPath = path.join(base, safePath);
    // Ensure fullPath is within base folder
    if (!fullPath.startsWith(path.resolve(base))) {
        return null;
    }
    // Also check that none of the path parts are dotfiles.
    if (hasDotfile(path.relative(base, fullPath))) {
        return null;
    }
    return fullPath;
}

// Helper: search upward for .htaccess error document directives
// Return an object mapping error code to error document path (absolute)
function searchHtaccess(startDir) {
    let curDir = startDir;
    while (true) {
        let htPath = path.join(curDir, ".htaccess");
        if (fs.existsSync(htPath)) {
            try {
                let content = fs.readFileSync(htPath, "utf8");
                let errors = {};
                let lines = content.split("\n");
                for (let line of lines) {
                    line = line.trim();
                    // e.g.: ErrorDocument 404 /404.php
                    if (line.indexOf("ErrorDocument") === 0) {
                        let parts = line.split(/\s+/);
                        if (parts.length >= 3) {
                            let code = parts[1];
                            let doc = parts.slice(2).join(" ");
                            // support relative paths: treat relative to curDir.
                            if (!path.isAbsolute(doc)) {
                                doc = path.join(curDir, doc);
                            }
                            errors[code] = doc;
                        }
                    }
                }
                return errors;
            } catch (err) {
                logError(`Error reading ${htPath}: ${err}`);
                return {};
            }
        }
        // if reached filesystem root or no parent, break.
        let parent = path.dirname(curDir);
        if (parent === curDir) break;
        curDir = parent;
    }
    return {};
}

// Helper: decide error response format based on Accept header
function clientWantsJson(req) {
    if (req.headers.accept && req.headers.accept.indexOf("application/json") !== -1) {
        return true;
    }
    return false;
}

// Helper: send error response
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

// Main function to handle requests
function handleRequest(req, res) {
    // Set idle timeout for connection (55 seconds)
    req.socket.setTimeout(IDLE_TIMEOUT_MS, () => {
        logError(`Idle timeout for ${req.socket.remoteAddress}`);
        req.destroy();
    });

    // Log request beginning time for access logging.
    const startTime = new Date();
    // Parse URL
    const parsedUrl = url.parse(req.url);
    const reqPath = parsedUrl.pathname;

    // Determine home folder based on Host header
    let home = getHomeForHost(req.headers.host);
    if (!home) {
        sendError(req, res, 404, "No matching host found");
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
        return;
    }

    let filePath = resolveSafe(home, reqPath);
    if (!filePath) {
        sendError(req, res, 404, "Not Found");
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
        return;
    }

    // Check if the path exists and get stats
    fs.stat(filePath, (err, stats) => {
        if (err) {
            // File not found. Check if request was for a directory (append / maybe):
            // For non-existent file, we consider error-document configuration.
            processErrorDocument(req, res, 404, filePath, home, startTime);
        } else {
            // If path is a directory then look for index files
            if (stats.isDirectory()) {
                // Try index.php, index.html, index.htm in order
                let indexes = ["index.php", "index.html", "index.htm"];
                (function next(i) {
                    if (i >= indexes.length) {
                        // None found: error document lookup
                        processErrorDocument(req, res, 404, filePath, home, startTime);
                        return;
                    }
                    let indexPath = path.join(filePath, indexes[i]);
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

// Serve a file at filePath. If PHP file, execute it; otherwise, stream out.
function serveFile(filePath, req, res, startTime) {
    // Never serve files that start with a dot
    if (path.basename(filePath).startsWith(".")) {
        sendError(req, res, 404, "Not Found");
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".php") {
        // Serve by executing PHP via command line.
        executePhp(filePath, req, res, startTime);
    } else {
        // Static file: stream file from disk.
        let stream = fs.createReadStream(filePath);
        stream.on("open", () => {
            // Set a generic content type based on file extension (could be improved)
            // Here we use basic types.
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
            logAccess(formatAccessLog(req, 200, 0, startTime)); // response size not tracked here
        });
    }
}

// Execute PHP file by spawning PHP as child process.
function executePhp(filePath, req, res, startTime) {
    // Build environment variables for PHP (following CGI style)
    let env = Object.assign({}, process.env);
    // Standard CGI Variables
    env.REQUEST_METHOD = req.method;
    env.QUERY_STRING = url.parse(req.url).query || "";
    env.DOCUMENT_ROOT = path.dirname(filePath);
    env.SCRIPT_FILENAME = filePath;
    env.SCRIPT_NAME = req.url;
    env.SERVER_NAME = req.headers.host ? req.headers.host.split(":")[0] : "localhost";
    env.SERVER_PORT = PORT;
    env.SERVER_PROTOCOL = "HTTP/1.1";
    // Pass all request headers as HTTP_* (similar to Apache)
    for (let header in req.headers) {
        let headerName = "HTTP_" + header.toUpperCase().replace(/-/g, "_");
        env[headerName] = req.headers[header];
    }
    // Include default headers that Photon sends (if any)
    // (For now, no defaults; PHP can override or add new ones via header())

    // Options: you may want to include any flags here (for now, none extra)
    let php = spawn(PHP_BIN, [filePath], { env });

    // For POST (or any method with body), pipe raw input to PHP’s stdin.
    req.pipe(php.stdin);

    // Variables to hold header parsing state
    let headerBuffer = "";
    let headersSent = false;

    // PHP stdout handling:
    php.stdout.on("data", (data) => {
        if (!headersSent) {
            headerBuffer += data.toString();
            // Check if we’ve got the header separator (double CRLF)
            let headerEnd = headerBuffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                headerEnd = headerBuffer.indexOf("\n\n");
            }
            if (headerEnd !== -1) {
                // Split headers and body
                let headerPart = headerBuffer.substring(0, headerEnd);
                let remaining = headerBuffer.substring(headerEnd).replace(/^\r?\n/, "");
                // Process header lines.
                let lines = headerPart.split(/\r?\n/);
                for (let line of lines) {
                    // Expect header lines in the form "Header-Name: Value"
                    let parts = line.split(":");
                    if (parts.length >= 2) {
                        let hName = parts[0].trim();
                        let hValue = parts.slice(1).join(":").trim();
                        // Set header if not already set by Photon defaults.
                        res.setHeader(hName, hValue);
                    }
                }
                // Write remaining body data
                res.write(remaining);
                headersSent = true;
            }
        } else {
            res.write(data);
        }
    });
    php.stdout.on("end", () => {
        res.end();
        logAccess(formatAccessLog(req, res.statusCode, 0, startTime));
    });

    // Capture PHP stderr (and log it)
    php.stderr.on("data", (data) => {
        logError(`PHP error (${filePath}): ${data}`);
    });
    php.on("error", (err) => {
        sendError(req, res, 500, "PHP Execution Error");
        logError(`Error executing PHP: ${err}`);
    });
    php.on("close", (code) => {
        // You might want to handle non-zero exit codes differently.
        if (code !== 0) {
            logError(`PHP exited with code ${code} for ${filePath}`);
        }
    });
}

// In case a file (or index file) isn’t found, check for error documents via .htaccess.
// If one is defined for the error code, process that file. Otherwise send generic error.
function processErrorDocument(req, res, statusCode, notFoundPath, base, startTime) {
    // Look up .htaccess in the directory of the notFoundPath (or its parent)
    let searchDir = fs.existsSync(notFoundPath) && fs.statSync(notFoundPath).isDirectory() ? notFoundPath : path.dirname(notFoundPath);
    let errors = searchHtaccess(searchDir);
    let doc = errors[String(statusCode)];
    if (doc && fs.existsSync(doc)) {
        // Serve error document (if PHP file, execute; otherwise static)
        const ext = path.extname(doc).toLowerCase();
        if (ext === ".php") {
            executePhp(doc, req, res, startTime);
        } else {
            let stream = fs.createReadStream(doc);
            // Set content type based on file extension (minimal support)
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

// Utility: format the access log in Apache Common Log Format
function formatAccessLog(req, status, size, startTime) {
    let remoteAddr = req.socket.remoteAddress || "-";
    let ident = "-";
    let user = "-";
    let now = new Date();
    // Example: [10/Oct/2000:13:55:36 -0700]
    let dateStr = now.toLocaleString("en-US", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false
    });
    let reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
    return `${remoteAddr} ${ident} ${user} [${dateStr}] "${reqLine}" ${status} ${size}`;
}

// Create the HTTP server
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    loadConfig();
    logError(`Photon server started on port ${PORT}`);
});
