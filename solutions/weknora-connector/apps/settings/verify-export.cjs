// Minimal structural check for the settings module export.
const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "settings.js");
const src = fs.readFileSync(target, "utf8");
if (!/export\s+(default|\{)/.test(src)) {
  console.error("settings.js is missing the required export (default or named).");
  process.exit(1);
}
console.log("settings.js export check OK");
