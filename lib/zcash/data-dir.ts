// Persistent location of the zkool watch-only wallet and zecHunt's quest-address map.
//
//   ZECHUNT_ZKOOL_DATA_DIR=/var/lib/zechunt/zkool     (absolute, not a temp directory)
//     watch-wallet.db          encrypted zkool wallet DB (zkool_graphql -d)
//     watch-wallet.db.voting   zkool's sidecar, created beside the wallet DB
//     wallet-password          DB encryption password, mode 0600 (--db-password-file)
//     quest-addresses.db       quest → Ironwood address map (ZkoolZcashAdapter mappingDbPath)
//
// Nothing here starts, stops or reads the wallet; it only computes and validates paths.
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const ZKOOL_DATA_DIR_ENV = "ZECHUNT_ZKOOL_DATA_DIR";

export interface ZkoolDataPaths {
  dataDir: string;
  walletDb: string;
  votingSidecar: string;
  passwordFile: string;
  mappingDb: string;
}

/** Temp roots that are wiped on reboot or by the OS. /tmp is a symlink to /private/tmp on macOS. */
function tempRoots(): string[] {
  const roots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders", "/dev/shm", tmpdir()];
  return [...new Set(roots.flatMap((r) => [r, safeRealpath(r)]))];
}

function safeRealpath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Resolves the nearest existing ancestor through symlinks, so "/data -> /tmp/x" is caught too. */
function realpathOfNearest(path: string): string {
  let current = path;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(safeRealpath(current), ...tail);
}

export function isUnderTempDir(path: string): boolean {
  const real = realpathOfNearest(resolve(path));
  return tempRoots().some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** Throws if the directory is unset, relative, a temp directory, or an existing non-directory. */
export function resolveZkoolDataDir(value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${ZKOOL_DATA_DIR_ENV} is not set`);
  if (!isAbsolute(value)) throw new Error(`${ZKOOL_DATA_DIR_ENV} must be an absolute path`);
  const dir = resolve(value);
  if (isUnderTempDir(dir)) throw new Error(`${ZKOOL_DATA_DIR_ENV} must not be a temporary directory`);
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error(`${ZKOOL_DATA_DIR_ENV} is not a directory`);
  return dir;
}

export function zkoolDataPaths(env: Readonly<Record<string, string | undefined>> = process.env): ZkoolDataPaths {
  const dataDir = resolveZkoolDataDir(env[ZKOOL_DATA_DIR_ENV]);
  const walletDb = join(dataDir, "watch-wallet.db");
  return {
    dataDir,
    walletDb,
    votingSidecar: `${walletDb}.voting`,
    passwordFile: join(dataDir, "wallet-password"),
    mappingDb: join(dataDir, "quest-addresses.db"),
  };
}

export interface ZkoolWatcherLaunch {
  paths: ZkoolDataPaths;
  /** Light-wallet server, e.g. https://testnet.zec.rocks:443 */
  lwdUrl: string;
  bindAddress: string;
  port: number;
  /** JWT public key for authenticated access. Without it the server must be loopback-only and explicitly unauthenticated. */
  jwtPublicKeyFile?: string;
  allowUnauthenticated?: boolean;
}

/**
 * zkool_graphql argv for the persistent watch-only wallet. Refuses to start when the wallet
 * DB is missing: zkool would silently create an EMPTY wallet, which needs a UFVK import and
 * a rescan. That's a separate, deliberate step, never a side effect of a restart.
 */
export function zkoolWatcherArgs(launch: ZkoolWatcherLaunch): string[] {
  const { paths } = launch;
  if (!existsSync(paths.walletDb)) throw new Error(`No wallet at ${paths.walletDb}; migrate it first (see docs/evidence/zcash)`);
  if (!existsSync(paths.passwordFile)) throw new Error(`No password file at ${paths.passwordFile}`);
  if ((statSync(paths.passwordFile).mode & 0o077) !== 0) throw new Error("The wallet password file must be mode 0600");
  if (!/^https:\/\//.test(launch.lwdUrl)) throw new Error("The light-wallet URL must be https");
  if (!Number.isSafeInteger(launch.port) || launch.port <= 0 || launch.port > 65535) throw new Error("Invalid port");
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(launch.bindAddress);
  const args = ["-d", paths.walletDb, "--db-password-file", paths.passwordFile, "-l", launch.lwdUrl,
    "-p", String(launch.port), "--bind-address", launch.bindAddress, "-C", "1"];
  if (launch.jwtPublicKeyFile) {
    args.push("-j", launch.jwtPublicKeyFile);
  } else {
    if (!launch.allowUnauthenticated) throw new Error("Set a JWT public key, or explicitly allow unauthenticated loopback access");
    if (!loopback) throw new Error("An unauthenticated wallet API must bind to loopback only");
    args.push("--allow-unauthenticated");
  }
  return args;
}
