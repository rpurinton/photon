"use strict";
const https = require("https");
const fs = require("fs");
const tls = require("tls");
const { loadConfig } = require("./config");
const { handleRequest } = require("./router");
const { logError } = require("./logger");

// Load configuration early so we can initialize certificates.
const config = loadConfig();

// Build the SNI context mapping for domains with a cert and key.
const sniContexts = {};
if (config.domains && Array.isArray(config.domains)) {
    config.domains.forEach(domainCfg => {
        if (domainCfg.cert && domainCfg.key) {
            const cert = fs.readFileSync(domainCfg.cert);
            const key = fs.readFileSync(domainCfg.key);
            // Allow comma-separated domains.
            const domains = domainCfg.domain.split(",").map(s => s.trim());
            domains.forEach(d => {
                sniContexts[d] = tls.createSecureContext({ cert, key });
            });
        }
    });
}

// Use the last domain entry in config as the default certificate.
let defaultCert, defaultKey;
const defaultDomain = config.domains && config.domains.length ? config.domains[config.domains.length - 1] : null;
if (defaultDomain && defaultDomain.cert && defaultDomain.key) {
    defaultCert = fs.readFileSync(defaultDomain.cert);
    defaultKey = fs.readFileSync(defaultDomain.key);
} else {
    logError("No default certificate provided in configuration.");
    defaultCert = "";
    defaultKey = "";
}

const httpsOptions = {
    key: defaultKey,
    cert: defaultCert,
    SNICallback: (servername, cb) => {
        // Use the certificate matching this server name, or fall back to default.
        if (sniContexts[servername]) {
            cb(null, sniContexts[servername]);
        } else {
            cb(null, tls.createSecureContext({ key: defaultKey, cert: defaultCert }));
        }
    }
};

// Only environment variable used now is PORT.
const PORT = process.env.PORT || 443;
const server = https.createServer(httpsOptions, handleRequest);

server.listen(PORT, () => {
    logError(`Photon server started on port ${PORT} (HTTPS)`);
});

// Handle termination signals for graceful shutdown.
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