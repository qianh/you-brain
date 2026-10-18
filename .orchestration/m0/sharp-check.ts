import sharp from "sharp";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

try {
  const webp = await sharp(png).webp({ quality: 80 }).toBuffer();
  const header = webp.subarray(0, 12).toString("ascii");
  const result = {
    ok: header.startsWith("RIFF") && header.includes("WEBP") && webp.length > 12,
    bytes: webp.length,
    header,
    sharp: sharp.versions,
    execPath: process.execPath,
    cwd: process.cwd(),
    compiledHint: !process.execPath.endsWith("/bun"),
  };
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      execPath: process.execPath,
      cwd: process.cwd(),
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }),
  );
  process.exit(1);
}
