import type { NextConfig } from "next";
// msedge-tts opens a WebSocket with the "ws" package, which must stay a plain Node dependency.
const config: NextConfig = { poweredByHeader: false, serverExternalPackages: ["msedge-tts"], async headers() { return [{ source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] }]; } };
export default config;
