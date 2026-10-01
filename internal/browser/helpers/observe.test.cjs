// Dependency-free DOM fixture test for the reviewed browser helper.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(__dirname + "/observe.js", "utf8");
function anchor(path, label, current = false, visible = true) {
 return {
  href: "https://discord.com" + path, innerText: label,
  getClientRects: () => visible ? [{}] : [],
  getAttribute: key => key === "aria-current" && current ? "page" : null,
  closest: () => null
 };
}
const links = [
 anchor("/channels/1/2", "general", true),
 anchor("/channels/1/2", "general"),
 anchor("/channels/1/3", "hidden", false, false),
 anchor("/channels/@me/9", "DM"),
 anchor("/channels/1/4/5", "nested"),
];
const heading = { textContent: "general", getClientRects: () => [{}] };
const sandbox = {
 URL,
 location: { href: "https://discord.com/channels/1/2" },
 document: { querySelectorAll: q => q.startsWith("a[") ? links : [heading] }
};
const observed = JSON.parse(JSON.stringify(vm.runInNewContext(source, sandbox)));
assert.equal(observed.selected_channel_id, "2");
assert.equal(observed.heading, "general");
assert.equal(observed.channels.length, 1);
assert.equal(observed.channels[0].url, "https://discord.com/channels/1/2");
console.log("DOM helper fixture passed");
