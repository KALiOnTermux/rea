import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function zipName(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

/**
 * DOS date/time of a ZIP entry.
 *
 * UTC, not local time: the archive has to be byte-identical on a host in another
 * timezone, which is what the manifest's determinism rule promises.
 */
function dosTimestamp(date = new Date()) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time:
      ((date.getUTCHours() & 0x1f) << 11) |
      ((date.getUTCMinutes() & 0x3f) << 5) |
      ((Math.floor(date.getUTCSeconds() / 2) & 0x1f) >>> 0),
    date:
      (((year - 1980) & 0x7f) << 9) |
      (((date.getUTCMonth() + 1) & 0x0f) << 5) |
      (date.getUTCDate() & 0x1f),
  };
}

/**
 * Collects files, compresses them as they are added and writes one ZIP at the
 * end. Keeping only compressed bytes in memory makes 25 MB source trees cheap.
 */
export class Bundle {
  constructor() {
    this.entries = [];
    this.rawBytes = 0;
    this.compressedBytes = 0;
    this.omitted = [];
  }

  addData(name, value) {
    const clean = zipName(name);
    if (!clean) return false;
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const deflated = deflateRawSync(raw, { level: 6 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    this.entries.push({
      name: clean,
      method: stored ? 0 : 8,
      body,
      crc: crc32(raw),
      size: raw.length,
      compressedSize: body.length,
    });
    this.rawBytes += raw.length;
    this.compressedBytes += body.length;
    return true;
  }

  async addFile(name, path) {
    const info = await stat(path);
    if (!info.isFile()) return false;
    return this.addData(name, await readFile(path));
  }

  /**
   * Add every regular file below root. Symlinks are never followed. The byte
   * and file caps keep one huge bundled asset tree from exhausting memory.
   */
  async addTree(prefix, root, options = {}) {
    const maxBytes = options.maxBytes ?? 40 * 1024 * 1024;
    const maxFiles = options.maxFiles ?? 6000;
    const ignore =
      options.ignore ??
      new Set(["node_modules", ".git", ".cache", "dist", "build"]);
    const allow = options.allow ?? (() => true);
    const result = { files: 0, bytes: 0, omitted: 0 };
    if (!root || !existsSync(root)) return result;

    const walk = async (directory, depth) => {
      if (depth > 24) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const full = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (ignore.has(entry.name)) continue;
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile() || !allow(full)) continue;
        if (result.files >= maxFiles) {
          result.omitted += 1;
          continue;
        }
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        if (info.size > maxBytes - result.bytes) {
          result.omitted += 1;
          this.omitted.push(relative(root, full));
          continue;
        }
        const inner = relative(root, full).split(sep).join("/");
        this.addData(`${prefix}/${inner}`, await readFile(full));
        result.files += 1;
        result.bytes += info.size;
      }
    };

    await walk(root, 0);
    return result;
  }

  /**
   * Serialises the archive. `date` pins the DOS timestamps so a reproducible
   * build produces byte-identical ZIPs; omitted, it records the build time.
   */
  toBuffer(date = undefined) {
    const { time: dosTime, date: dosDate } = dosTimestamp(date);
    const time = dosTime;
    const dateField = dosDate;
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const entry of this.entries) {
      const name = Buffer.from(entry.name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(entry.method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(dateField, 12);
      local.writeUInt32LE(entry.crc, 14);
      local.writeUInt32LE(entry.compressedSize, 18);
      local.writeUInt32LE(entry.size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      chunks.push(local, name, entry.body);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(0x0314, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(dateField, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      header.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([header, name]));

      offset += local.length + name.length + entry.body.length;
    }

    const centralBuffer = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...chunks, centralBuffer, end]);
  }
}
