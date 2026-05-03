const assert = require("node:assert/strict");
const { buildSingBoxTunConfig } = require("../src/engine/singBoxConfig");

const sample = {
  id: "sample",
  name: "Sample",
  protocol: "http",
  host: "proxy.example.com",
  port: "8080",
  username: "user",
  password: "pass",
  methodType: "http-proxy"
};

const built = buildSingBoxTunConfig(sample);

assert.equal(built.inbounds[0].type, "tun");
assert.equal(built.inbounds[0].interface_name, "TerousdTun");
assert.equal(built.inbounds[0].auto_route, true);
assert.equal(built.outbounds[0].type, "http");
assert.equal(built.outbounds[0].server, "proxy.example.com");
assert.equal(built.outbounds[0].server_port, 8080);
assert.equal(built.outbounds[0].username, "user");
assert.equal(built.outbounds[0].domain_resolver, "local-dns");
assert.equal(built.dns.final, "local-dns");
assert.equal(built.route.rules[0].action, "hijack-dns");
assert.equal(built.route.rules[2].network, "udp");
assert.equal(built.route.rules[2].action, "reject");
assert.equal(built.route.final, "proxy");

const socksBuilt = buildSingBoxTunConfig({
  id: "proxy",
  name: "Proxy",
  protocol: "socks5",
  host: "proxy.example.com",
  port: "1080",
  methodType: "socks5-proxy"
});

assert.equal(socksBuilt.outbounds[0].type, "socks");
assert.equal(socksBuilt.outbounds[0].version, "5");
assert.equal(socksBuilt.outbounds[0].server_port, 1080);

console.log("PC client sanity checks passed.");
