#!/usr/bin/env node
/**
 * 生成 Tauri 静态更新清单（本机签名模式）。
 *
 * 用于没有在 GitHub Actions 配置 TAURI_SIGNING_PRIVATE_KEY 的情况：
 * CI 只产出普通安装包，签名和 latest.json 在本机完成，再上传到静态分发目录。
 *
 * 用法：
 *   node scripts/make-update.mjs <setup.exe> [私钥路径] [输出目录]
 *
 * 产出：
 *   <setup.exe>.sig            签名文件（Tauri CLI 生成）
 *   <输出目录>/latest.json      静态更新清单
 *
 * 私钥默认在 C:/Users/Administrator/.workbuddy/keys/linggan10s-updater.key，
 * 绝不提交进仓库。版本与 endpoint 都从 src-tauri/tauri.conf.json 读取，避免手抄出错。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2];
const key =
  process.argv[3] ||
  "C:/Users/Administrator/.workbuddy/keys/linggan10s-updater.key";
const outDir = process.argv[4] || ".";

if (!file || !existsSync(file)) {
  console.error("用法: node scripts/make-update.mjs <setup.exe> [私钥路径] [输出目录]");
  process.exit(1);
}
if (!existsSync(key)) {
  console.error("找不到签名私钥:", key);
  process.exit(1);
}

const confPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const version = conf.version;
const endpoint = conf.plugins?.updater?.endpoints?.[0];
if (!version || !endpoint) {
  console.error("tauri.conf.json 里缺少 version 或 plugins.updater.endpoints[0]");
  process.exit(1);
}
const base = endpoint.slice(0, endpoint.lastIndexOf("/") + 1);
const exeName = basename(file);

// Tauri CLI 会在被签文件旁生成 <file>.sig。Windows 上 npx 是 .cmd，需要 shell。
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(npx, ["tauri", "signer", "sign", "-f", key, file], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
const signature = readFileSync(`${file}.sig`, "utf8").trim();

const manifest = {
  version: `v${version}`,
  notes: `灵感10s v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${base}${exeName}`,
    },
  },
};
const outPath = resolve(outDir, "latest.json");
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log("\n已生成:", outPath);
console.log("endpoint:", endpoint);
console.log("需要上传两个文件到静态目录:", exeName, "和 latest.json");
