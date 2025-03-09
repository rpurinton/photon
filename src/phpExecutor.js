// File: phpExecutor.js

"use strict";
const { spawn } = require("child_process");
const url = require("url");
const { logError, logAccess } = require("./logger");
const PHP_BIN = "/usr/bin/php"; // Change if needed

// Execute the PHP file by spawning the PHP process.
// Pipes request data into PHP and send the PHP output to the response.
function executePhp(filePath, req, res, startTime) {
    let env = Object.assign({}, process.env);
    env.REQUEST_METHOD = req.method;
    env.QUERY_STRING = url.parse(req.url).query || "";
    env.DOCUMENT_ROOT = require("path").dirname(filePath);
    env.SCRIPT_FILENAME = filePath;
    env.SCRIPT_NAME = req.url;
    env.SERVER_NAME = req.headers.host ? req.headers.host.split(":")[0] : "localhost";
    env.SERVER_PORT = process.env.PORT || 80;
    env.SERVER_PROTOCOL = "HTTP/1.1";

    // Copy request headers into the CGI environment.
    for (let header in req.headers) {
        let headerName = "HTTP_" + header.toUpperCase().replace(/-/g, "_");
        env[headerName] = req.headers[header];
    }

    let php = spawn(PHP_BIN, [filePath], { env });

    req.pipe(php.stdin);

    let headerBuffer = "";
    let headersSent = false;

    php.stdout.on("data", (data) => {
        if (!headersSent) {
            headerBuffer += data.toString();
            let headerEnd = headerBuffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                headerEnd = headerBuffer.indexOf("\n\n");
            }
            if (headerEnd !== -1) {
                const headerPart = headerBuffer.substring(0, headerEnd);
                const remaining = headerBuffer.substring(headerEnd).replace(/^\r?\n/, "");
                const lines = headerPart.split(/\r?\n/);
                for (let line of lines) {
                    let parts = line.split(":");
                    if (parts.length >= 2) {
                        let hName = parts[0].trim();
                        let hValue = parts.slice(1).join(":").trim();
                        res.setHeader(hName, hValue);
                    }
                }
                res.write(remaining);
                headersSent = true;
            }
        } else {
            res.write(data);
        }
    });

    php.stdout.on("end", () => {
        res.end();
        logAccess(require("./utils").formatAccessLog(req, res.statusCode, 0, startTime));
    });

    php.stderr.on("data", (data) => {
        logError(`PHP error (${filePath}): ${data}`);
    });

    php.on("error", (err) => {
        const { sendError } = require("./utils");
        sendError(req, res, 500, "PHP Execution Error");
        logError(`Error executing PHP: ${err}`);
    });

    php.on("close", (code) => {
        if (code !== 0) {
            logError(`PHP exited with code ${code} for ${filePath}`);
        }
    });
}

module.exports = { executePhp };