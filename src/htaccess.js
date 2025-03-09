// File: htaccess.js

"use strict";
const fs = require("fs");
const path = require("path");
const { logError } = require("./logger");

// Walk upward from the given start directory looking for a ".htaccess"
// and returns an object mapping error codes to error document paths.
function searchHtaccess(startDir) {
    let curDir = startDir;
    while (true) {
        let htPath = path.join(curDir, ".htaccess");
        if (fs.existsSync(htPath)) {
            try {
                let content = fs.readFileSync(htPath, "utf8");
                let errors = {};
                const lines = content.split("\n");
                for (let line of lines) {
                    line = line.trim();
                    if (line.indexOf("ErrorDocument") === 0) {
                        let parts = line.split(/\s+/);
                        if (parts.length >= 3) {
                            let code = parts[1];
                            let doc = parts.slice(2).join(" ");
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
        const parent = path.dirname(curDir);
        if (parent === curDir) break;
        curDir = parent;
    }
    return {};
}

module.exports = { searchHtaccess };
