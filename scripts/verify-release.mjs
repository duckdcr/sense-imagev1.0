import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_RELEASE_PATHS = Object.freeze([
  "runtime/node.exe",
  "node_modules/@img/sharp-win32-x64/package.json",
  "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node",
  "assets/curtain-product/grommet-template.png",
  "assets/curtain-product/double-pinch-template.png",
  "assets/curtain-scene/scene-1.png",
  "assets/curtain-scene/scene-2.png",
  "assets/curtain-scene/scene-3.png",
  "assets/curtain-scene/scene-4.png",
  "assets/curtain-scene/scene-5.png",
  "public/index.html",
  "public/app.js",
  "public/creation.html",
  "public/creation.js",
  "public/editablePromptSettings.js",
  "src/curtainProductPrompt.js",
  "src/curtainCreationPrompt.js",
  "src/promptSettings.js",
  "config/prompts.json",
  "scripts/start.ps1",
  "scripts/verify-release.mjs",
  "server.js",
  "package.json",
  "package-lock.json",
  "README.txt",
  "start.bat",
  "启动.bat",
]);

const REQUIRED_DIRECTORIES = Object.freeze(["data/history"]);
const PROHIBITED_PATHS = Object.freeze(["logs", ".env"]);

export async function verifyWindowsRelease(rootDirectory) {
  const root = path.resolve(String(rootDirectory || ""));
  const errors = [];

  for (const relativePath of REQUIRED_RELEASE_PATHS) {
    const target = path.join(root, relativePath);
    try {
      if (!(await stat(target)).isFile()) errors.push(`不是文件：${relativePath}`);
    } catch {
      errors.push(`缺少文件：${relativePath}`);
    }
  }

  for (const relativePath of REQUIRED_DIRECTORIES) {
    const target = path.join(root, relativePath);
    try {
      if (!(await stat(target)).isDirectory()) errors.push(`不是目录：${relativePath}`);
    } catch {
      errors.push(`缺少目录：${relativePath}`);
    }
  }

  for (const relativePath of PROHIBITED_PATHS) {
    try {
      await stat(path.join(root, relativePath));
      errors.push(`交付目录不应包含：${relativePath}`);
    } catch {}
  }

  try {
    const historyEntries = await readdir(path.join(root, "data", "history"));
    if (historyEntries.length) errors.push("data/history 必须为空");
  } catch {}

  try {
    const handle = await open(path.join(root, "runtime", "node.exe"), "r");
    try {
      const signature = Buffer.alloc(2);
      await handle.read(signature, 0, 2, 0);
      if (signature.toString("ascii") !== "MZ") {
        errors.push("runtime/node.exe 不是有效的 Windows PE 文件");
      }
    } finally {
      await handle.close();
    }
  } catch {}

  return { ok: errors.length === 0, errors };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const target = process.argv[2];
  if (!target) {
    console.error("用法：node scripts/verify-release.mjs <交付目录>");
    process.exitCode = 1;
  } else {
    const result = await verifyWindowsRelease(target);
    if (result.ok) {
      console.log("Windows release verification passed");
    } else {
      result.errors.forEach((message) => console.error(`- ${message}`));
      process.exitCode = 1;
    }
  }
}
