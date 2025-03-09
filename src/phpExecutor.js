// File: phpExecutor.js

"use strict";
const { spawn } = require("child_process");
const url = require("url");
const { logError, logAccess } = require("./logger");
const PHP_BIN = "/usr/bin/php"; // Change if needed

// Execute the PHP file by spawning the PHP process.
// Pipes request data into PHP and send the PHP output to the response.
function executePhp(filePath, req, res, startTime) {
    console.log("Starting PHP execution for:", filePath);

    let env = Object.assign({}, process.env);
    env.REQUEST_METHOD = req.method;
    env.QUERY_STRING = url.parse(req.url).query || "";
    env.DOCUMENT_ROOT = require("path").dirname(filePath);
    env.SCRIPT_FILENAME = filePath;
    env.SCRIPT_NAME = req.url;
    env.SERVER_NAME = req.headers.host ? req.headers.host.split(":")[0] : "localhost";
    env.SERVER_PORT = process.env.PHOTON_PORT || 80;
    env.SERVER_PROTOCOL = "HTTP/1.1";

    console.log("Environment variables set:", env);

    // Copy request headers into the CGI environment.
    for (let header in req.headers) {
        let headerName = "HTTP_" + header.toUpperCase().replace(/-/g, "_");
        env[headerName] = req.headers[header];
    }

    console.log("Request headers copied to environment:", env);

    let php = spawn(PHP_BIN, [filePath], { env });

    req.pipe(php.stdin);

    let headerBuffer = "";
    let headersSent = false;

    php.stdout.on("data", (data) => {
        console.log("PHP stdout data received:", data.toString());
        if (!headersSent) {
            headerBuffer += data.toString();
            let headerEnd = headerBuffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                headerEnd = headerBuffer.indexOf("\n\n");
            }
            if (headerEnd !== -1) {
                const headerPart = headerBuffer.substring(0, headerEnd);
                const remaining = headerBuffer.substring(headerEnd + 2).replace(/^\r?\n/, "");
                const lines = headerPart.split(/\r?\n/);
                for (let line of lines) {
                    let parts = line.split(":");
                    if (parts.length >= 2) {
                        let hName = parts[0].trim();
                        let hValue = parts.slice(1).join(":").trim();
                        res.setHeader(hName, hValue);
                        console.log(`Header set: ${hName} = ${hValue}`);
                    }
                }
                res.write(remaining);
                headersSent = true;
                console.log("Headers sent to response.");
            }
        } else {
            res.write(data);
        }
    });

    php.stdout.on("end", () => {
        console.log("PHP stdout end.");
        res.end();
        logAccess(require("./utils").formatAccessLog(req, res.statusCode, 0, startTime));
    });

    php.stderr.on("data", (data) => {
        console.error(`PHP error (${filePath}): ${data}`);
        logError(`PHP error (${filePath}): ${data}`);
    });

    php.on("error", (err) => {
        console.error(`Error executing PHP: ${err}`);
        const { sendError } = require("./utils");
        sendError(req, res, 500, "PHP Execution Error");
        logError(`Error executing PHP: ${err}`);
    });

    php.on("close", (code) => {
        console.log(`PHP process closed with code ${code}`);
        if (code !== 0) {
            logError(`PHP exited with code ${code} for ${filePath}`);
        }
    });
}

module.exports = { executePhp };