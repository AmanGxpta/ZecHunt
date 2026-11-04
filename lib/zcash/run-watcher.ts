// Starts zkool_graphql against the persistent watch-only wallet in ZECHUNT_ZKOOL_DATA_DIR.
//
//   ZECHUNT_ZKOOL_BIN=/path/to/zkool_graphql \
//   ZECHUNT_ZKOOL_DATA_DIR=/var/lib/zechunt/zkool \
//   ZECHUNT_ZKOOL_GRAPHQL_URL=http://127.0.0.1:8766/graphql \
//   ZECHUNT_ZKOOL_ALLOW_UNAUTHENTICATED=true \
//   node --import tsx lib/zcash/run-watcher.ts
//
// Optional: ZECHUNT_ZKOOL_LWD_URL (default https://testnet.zec.rocks:443),
// ZECHUNT_ZKOOL_JWT_PUBLIC_KEY_FILE (enables JWT auth instead of loopback-only access).
// It refuses to start without an existing wallet, so a restart never creates an empty one.
import { spawn } from "node:child_process";
import { zkoolDataPaths, zkoolWatcherArgs } from "./data-dir";

const bin = process.env.ZECHUNT_ZKOOL_BIN;
if (!bin) throw new Error("Set ZECHUNT_ZKOOL_BIN to the zkool_graphql binary");
const url = new URL(process.env.ZECHUNT_ZKOOL_GRAPHQL_URL ?? "http://127.0.0.1:8766/graphql");
const args = zkoolWatcherArgs({
  paths: zkoolDataPaths(),
  lwdUrl: process.env.ZECHUNT_ZKOOL_LWD_URL ?? "https://testnet.zec.rocks:443",
  bindAddress: url.hostname.replace(/^\[|\]$/g, ""),
  port: Number(url.port || 80),
  jwtPublicKeyFile: process.env.ZECHUNT_ZKOOL_JWT_PUBLIC_KEY_FILE || undefined,
  allowUnauthenticated: process.env.ZECHUNT_ZKOOL_ALLOW_UNAUTHENTICATED === "true",
});
// Paths and flags only; the password stays in its file.
console.log(`zkool_graphql ${args.join(" ")}`);
const child = spawn(bin, args, { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
