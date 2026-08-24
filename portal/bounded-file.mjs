import { promises as fs } from 'node:fs';

export async function readBoundedFileTail(path, maximumBytes) {
  const stat = await fs.stat(path).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!stat?.isFile() || stat.size === 0) {
    return { content: '', size: 0, returnedBytes: 0, truncated: false };
  }
  const start = Math.max(0, stat.size - maximumBytes);
  const length = stat.size - start;
  const buffer = Buffer.allocUnsafe(length);
  const handle = await fs.open(path, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let value = decodeUtf8Boundary(buffer.subarray(0, bytesRead));
    if (start > 0) {
      const newline = value.indexOf('\n');
      if (newline >= 0) value = value.slice(newline + 1);
    }
    return {
      content: value,
      size: stat.size,
      returnedBytes: Buffer.byteLength(value),
      truncated: start > 0,
    };
  } finally {
    await handle.close();
  }
}

function decodeUtf8Boundary(buffer) {
  let start = 0;
  while (start < Math.min(4, buffer.length) && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}
