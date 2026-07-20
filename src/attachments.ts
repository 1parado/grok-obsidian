import { App, TFile } from "obsidian";
import type { ChatAttachment } from "./chatTypes";
import type { AcpImageInput } from "./grokAcpRunner";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function imageMime(file: File): string {
  return file.type.startsWith("image/") ? file.type : "image/png";
}

async function pngBuffer(file: File): Promise<ArrayBuffer> {
  const original = await file.arrayBuffer();
  if (imageMime(file) === "image/png" && original.byteLength <= MAX_IMAGE_BYTES) {
    return original;
  }

  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建图片画布");
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("图片转换失败"))), "image/png");
    });
    const converted = await blob.arrayBuffer();
    if (converted.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("图片过大，请粘贴较小的截图");
    }
    return converted;
  } finally {
    bitmap.close();
  }
}

function attachmentName(index: number): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .slice(0, 22);
  return `Grok Screenshot ${stamp}-${index + 1}.png`;
}

export async function saveImageFiles(
  app: App,
  files: File[],
  sourcePath?: string,
): Promise<ChatAttachment[]> {
  const saved: ChatAttachment[] = [];
  for (const [index, file] of files.slice(0, 4).entries()) {
    if (!file.type.startsWith("image/") && !file.name.match(/\.(png|jpe?g|gif|webp|bmp)$/i)) {
      continue;
    }
    const data = await pngBuffer(file);
    const path = await app.fileManager.getAvailablePathForAttachment(attachmentName(index), sourcePath);
    const created = await app.vault.createBinary(path, data);
    saved.push({
      id: `${created.path}-${created.stat.mtime}`,
      path: created.path,
      name: created.name,
      mimeType: "image/png",
      kind: "image",
    });
  }
  return saved;
}

export async function saveDroppedFiles(
  app: App,
  files: File[],
  sourcePath?: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files.slice(0, 8)) {
    if (file.type.startsWith("image/")) continue;
    const safeName = file.name.replace(/[\\/:*?"<>|]/g, "-") || `Dropped file ${Date.now()}`;
    const path = await app.fileManager.getAvailablePathForAttachment(safeName, sourcePath);
    await app.vault.createBinary(path, await file.arrayBuffer());
    paths.push(path);
  }
  return paths;
}

export function attachmentResourcePath(app: App, attachment: ChatAttachment): string {
  return app.vault.adapter.getResourcePath(attachment.path);
}

export async function attachmentToAcpImage(
  app: App,
  attachment: ChatAttachment,
): Promise<AcpImageInput | null> {
  const file = app.vault.getAbstractFileByPath(attachment.path);
  if (!(file instanceof TFile)) return null;
  const binary = await app.vault.readBinary(file);
  return {
    data: Buffer.from(binary).toString("base64"),
    mimeType: attachment.mimeType,
    uri: attachment.path,
  };
}

/** True for images created by this plugin (safe to auto-delete on cleanup). */
export function isPluginManagedScreenshot(pathOrName: string): boolean {
  const name = pathOrName.split(/[/\\]/).pop() ?? pathOrName;
  return /^Grok Screenshot /i.test(name);
}

export async function deleteVaultFiles(app: App, paths: string[]): Promise<number> {
  let deleted = 0;
  for (const path of Array.from(new Set(paths))) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) continue;
    try {
      await app.vault.delete(file);
      deleted += 1;
    } catch {
      /* ignore missing/locked */
    }
  }
  return deleted;
}
