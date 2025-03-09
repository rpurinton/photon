// File: server.js

"use strict";
const http = require("http");
const { loadConfig } = require("./config");
const { handleRequest } = require("./router");
const { logError } = require("./logger");

const PORT = process.env.PHOTON_PORT || 80;

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    loadConfig();
    logError(`Photon server started on port ${PORT}`);
});

// Handle termination signals for graceful shutdown and config reload.
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
