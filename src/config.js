// File: config.js

"use strict";
const fs = require("fs");
const path = require("path");
const { logError } = require("./logger");

const CONFIG_PATH = path.join(__dirname, "../config/Photon.json");

let config = null;

function loadConfig() {
    try {
        const data = fs.readFileSync(CONFIG_PATH, "utf8");
        config = JSON.parse(data);
        logError(`Config loaded: ${CONFIG_PATH}`);
    } catch (err) {
        logError(`Error loading config: ${err}`);
        process.exit(1);
    }
}

// Given a host header value, see if it matches any configured domain.
// Each config entry is assumed to have: { "domain": "example.com" or "*.example.com", "home": "/path/to/home" }
function getHomeForHost(host) {
    if (!host) return null;
    host = host.split(":")[0].toLowerCase();
    if (!config || !config.domains) return null;

    for (let entry of config.domains) {
        let domain = entry.domain.toLowerCase();
        if (domain.startsWith("*.")) {
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

function getConfig() {
    return config;
}

module.exports = { loadConfig, getConfig, getHomeForHost, CONFIG_PATH };
