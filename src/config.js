"use strict";
const fs = require("fs");
const path = require("path");

let config = null;

function loadConfig() {
    const configPath = "/etc/photon/photon.json";
    const rawConfig = fs.readFileSync(configPath);
    config = JSON.parse(rawConfig);
    return config; // return the parsed config
}

function getHomeForHost(host) {
    if (!config) {
        loadConfig();
    }
    for (const domainConfig of config.domains) {
        const domains = domainConfig.domain.split(",").map(d => d.trim());
        if (domains.includes(host)) {
            return domainConfig.home;
        }
    }
    return null;
}

function getEnvForHost(host) {
    if (!config) {
        loadConfig();
    }
    for (const domainConfig of config.domains) {
        const domains = domainConfig.domain.split(",").map(d => d.trim());
        if (domains.includes(host)) {
            return domainConfig.env || {};
        }
    }
    return {};
}

module.exports = { loadConfig, getHomeForHost, getEnvForHost };