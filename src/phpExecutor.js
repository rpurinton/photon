"use strict";
const { spawn } = require("child_process");
const url = require("url");
const { logError, logAccess } = require("./logger");
const { getEnvForHost } = require("./config");

const PHP_BIN = "/usr/bin/php-cgi"; // Change if needed

function executePhp(filePath, req, res, startTime) {
    let env = Object.assign({}, process.env, getEnvForHost(req.headers.host));

    env.REQUEST_METHOD = req.method;
    env.QUERY_STRING = url.parse(req.url).query || "";
    env.DOCUMENT_ROOT = require("path").dirname(filePath);
    env.SCRIPT_FILENAME = filePath;
    env.SCRIPT_NAME = req.url;
    env.REQUEST_URI = req.url;
    env.PATH_INFO = req.url;
    env.SERVER_NAME = req.headers.host ? req.headers.host.split(":")[0] : "localhost";

    // Set HTTPS-related variables for PHP
    env.HTTPS = "on";
    env.SERVER_PORT = process.env.PHOTON_PORT || "443";
    env.SERVER_PROTOCOL = "HTTPS/1.1";

    env.REDIRECT_STATUS = "200";

    env.HTTP_HOST = req.headers.host;
    env.REMOTE_ADDR = req.socket.remoteAddress;
    env.REMOTE_PORT = req.socket.remotePort;
    env.SERVER_ADDR = req.socket.localAddress || "127.0.0.1";
    env.SERVER_SOFTWARE = "Photon";
    env.GATEWAY_INTERFACE = "CGI/1.1";

    if (req.headers["content-type"]) {
        env.CONTENT_TYPE = req.headers["content-type"];
    }
    if (req.headers["content-length"]) {
        env.CONTENT_LENGTH = req.headers["content-length"];
    }

    if (req.headers.authorization) {
        env.HTTP_AUTHORIZATION = req.headers.authorization;
    }
    // Explicitly pass the cookie header if available.
    if (req.headers.cookie) {
        env.HTTP_COOKIE = req.headers.cookie;
    }

    for (let header in req.headers) {
        const headerName = "HTTP_" + header.toUpperCase().replace(/-/g, "_");
        if (!(headerName in env)) {
            env[headerName] = req.headers[header];
        }
    }

    let php = spawn(PHP_BIN, [], { env });

    // Pipe the body (e.g. www‑encoded POST fields) so PHP can read it into $_POST
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
                const remaining = headerBuffer.substring(headerEnd + 2).replace(/^\r?\n/, "");
                const lines = headerPart.split(/\r?\n/);
                for (let line of lines) {
                    let parts = line.split(":");
                    if (parts.length >= 2) {
                        let hName = parts[0].trim();
                        let hValue = parts.slice(1).join(":").trim();
                        // Handle multiple Set-Cookie headers properly:
                        if (hName.toLowerCase() === "set-cookie") {
                            let current = res.getHeader("Set-Cookie");
                            if (current) {
                                if (!Array.isArray(current)) {
                                    current = [current];
                                }
                                current.push(hValue);
                                res.setHeader("Set-Cookie", current);
                            } else {
                                res.setHeader("Set-Cookie", hValue);
                            }
                        } else {
                            res.setHeader(hName, hValue);
                        }
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
        if (!headersSent && headerBuffer.length > 0) {
            res.write(headerBuffer);
        }
        res.end();
        logAccess(require("./utils").formatAccessLog(req, res.statusCode, 0, startTime));
    });

    php.stderr.on("data", (data) => {
        logError(`PHP-CGI error (${filePath}): ${data}`);
    });

    php.on("error", (err) => {
        const { sendError } = require("./utils");
        sendError(req, res, 500, "PHP Execution Error");
        logError(`Error executing PHP-CGI: ${err}`);
    });

    php.on("close", (code) => {
        if (code !== 0) {
            logError(`PHP-CGI exited with code ${code} for ${filePath}`);
        }
    });
}

module.exports = { executePhp };