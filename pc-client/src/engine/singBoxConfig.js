function buildSingBoxTunConfig(profile, options = {}) {
  const outbound = proxyOutbound(profile);
  const tunOptions = tunConfigOptions(options);
  applyBindInterface(outbound, tunOptions.defaultInterface);
  const directOutbound = {
    type: "direct",
    tag: "direct"
  };
  applyBindInterface(directOutbound, tunOptions.defaultInterface);
  return {
    log: {
      level: "warn",
      timestamp: true
    },
    dns: {
      servers: [
        {
          type: "local",
          tag: "local-dns"
        }
      ],
      final: "local-dns",
      strategy: "ipv4_only"
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        interface_name: tunOptions.interfaceName,
        address: [
          "172.19.0.1/30"
        ],
        mtu: 1500,
        auto_route: true,
        strict_route: tunOptions.strictRoute,
        stack: tunOptions.stack
      }
    ],
    outbounds: [
      outbound,
      directOutbound,
      {
        type: "block",
        tag: "block"
      }
    ],
    route: {
      rules: [
        {
          protocol: "dns",
          action: "hijack-dns"
        },
        {
          port: 53,
          action: "hijack-dns"
        },
        {
          network: "udp",
          action: "reject"
        }
      ],
      auto_detect_interface: !hasValue(tunOptions.defaultInterface),
      ...(hasValue(tunOptions.defaultInterface) ? { default_interface: tunOptions.defaultInterface } : {}),
      default_domain_resolver: "local-dns",
      final: "proxy"
    }
  };
}

function proxyOutbound(profile) {
  const protocol = proxyProtocol(profile);
  const host = valueOr(profile.host, valueOr(profile.bugHost, profile.remoteProxyHost));
  const port = intValue(valueOr(profile.port, profile.remoteProxyPort), 0);
  if (!hasValue(host) || port <= 0) {
    throw new Error("Proxy profile is missing host or port.");
  }

  const outbound = {
    type: protocol === "socks5" ? "socks" : "http",
    tag: "proxy",
    server: host,
    server_port: port,
    domain_resolver: "local-dns",
    detour: "direct"
  };

  if (protocol === "socks5") {
    outbound.version = "5";
  }
  if (hasValue(profile.username)) {
    outbound.username = profile.username;
  }
  if (hasValue(profile.password)) {
    outbound.password = profile.password;
  }
  return outbound;
}

function tunConfigOptions(options) {
  return {
    interfaceName: hasValue(options.interfaceName) ? String(options.interfaceName).trim() : "TerousdTun",
    strictRoute: options.strictRoute !== false,
    stack: hasValue(options.stack) ? String(options.stack).trim() : "mixed",
    defaultInterface: hasValue(options.defaultInterface) ? String(options.defaultInterface).trim() : ""
  };
}

function applyBindInterface(outbound, interfaceName) {
  if (hasValue(interfaceName)) {
    outbound.bind_interface = String(interfaceName).trim();
  }
}

function proxyProtocol(profile) {
  const value = String(profile.protocol || profile.methodType || profile.bugType || "").trim().toLowerCase();
  return value.includes("socks") ? "socks5" : "http";
}

function intValue(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasValue(value) {
  return value != null && String(value).trim().length > 0;
}

function valueOr(value, fallback) {
  return hasValue(value) ? String(value).trim() : fallback || "";
}

module.exports = {
  buildSingBoxTunConfig
};
