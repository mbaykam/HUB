#!/usr/bin/env node

const { app, BrowserWindow } = require("electron");
const {
  mkdir,
  readFile,
  writeFile,
} = require("node:fs/promises");
const { join, resolve } = require("node:path");

const projectRoot = resolve(process.argv[2] ?? ".");
const brandRoot = join(projectRoot, "assets", "brand");
const pwaRoot = join(
  projectRoot,
  "packages",
  "harness-overlay",
  "assets",
  "pwa",
);
const publicRoot = join(projectRoot, "public");
const outputRoot = join(projectRoot, "resources", "icons");

async function imageFromSvg(svg) {
  const renderer = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      offscreen: true,
      sandbox: true,
    },
  });
  const document = [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<style>",
    "html,body{width:1024px;height:1024px;margin:0;overflow:hidden;background:transparent}",
    "svg{display:block;width:1024px;height:1024px}",
    "</style>",
    svg,
  ].join("");
  try {
    await renderer.loadURL(
      `data:text/html;base64,${Buffer.from(document).toString("base64")}`,
    );
    const source = await renderer.webContents.capturePage({
      x: 0,
      y: 0,
      width: 1024,
      height: 1024,
    });
    if (source.isEmpty()) {
      throw new Error("Electron could not render the HUB SVG source");
    }
    return source;
  } finally {
    renderer.destroy();
  }
}

function pngAt(source, size) {
  return source.resize({
    width: size,
    height: size,
    quality: "best",
  }).toPNG();
}

function windowsIcon(images) {
  const headerSize = 6;
  const entrySize = 16;
  let imageOffset = headerSize + entrySize * images.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    imageOffset += data.length;
    return entry;
  });
  return Buffer.concat([
    header,
    ...entries,
    ...images.map(({ data }) => data),
  ]);
}

function macIcon(source) {
  const variants = [
    ["icp4", 16],
    ["icp5", 32],
    ["ic11", 32],
    ["icp6", 64],
    ["ic12", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic13", 256],
    ["ic09", 512],
    ["ic14", 512],
    ["ic10", 1024],
  ];
  const entries = variants.map(([type, size]) => {
    const data = pngAt(source, size);
    const entry = Buffer.alloc(8 + data.length);
    entry.write(type, 0, 4, "ascii");
    entry.writeUInt32BE(entry.length, 4);
    data.copy(entry, 8);
    return entry;
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(
    header.length + entries.reduce((sum, entry) => sum + entry.length, 0),
    4,
  );
  return Buffer.concat([header, ...entries]);
}

async function render() {
  const [iconSvg, fullbleedSvg, markSvg] = await Promise.all([
    readFile(join(brandRoot, "hub-icon.svg"), "utf8"),
    readFile(join(pwaRoot, "icon-fullbleed.svg"), "utf8"),
    readFile(join(brandRoot, "hub-mark.svg"), "utf8"),
  ]);
  const [icon, fullbleed, mark] = await Promise.all([
    imageFromSvg(iconSvg),
    imageFromSvg(fullbleedSvg),
    imageFromSvg(markSvg.replaceAll("#0b0e17", "#000000")),
  ]);
  await Promise.all([
    mkdir(publicRoot, { recursive: true }),
    mkdir(outputRoot, { recursive: true }),
    mkdir(pwaRoot, { recursive: true }),
  ]);

  const windowsSizes = [16, 20, 24, 32, 40, 48, 64, 256];
  const windowsImages = windowsSizes.map((size) => ({
    size,
    data: pngAt(icon, size),
  }));

  await Promise.all([
    writeFile(join(publicRoot, "logo.png"), pngAt(icon, 1024)),
    writeFile(join(publicRoot, "minke.png"), pngAt(icon, 1024)),
    writeFile(join(publicRoot, "minke-tray.png"), pngAt(mark, 1024)),
    writeFile(join(outputRoot, "icon.png"), pngAt(icon, 512)),
    writeFile(join(outputRoot, "icon.ico"), windowsIcon(windowsImages)),
    writeFile(join(outputRoot, "icon.icns"), macIcon(icon)),
    writeFile(join(outputRoot, "trayTemplate.png"), pngAt(mark, 16)),
    writeFile(join(outputRoot, "trayTemplate@2x.png"), pngAt(mark, 32)),
    writeFile(join(pwaRoot, "icon-192.png"), pngAt(fullbleed, 192)),
    writeFile(join(pwaRoot, "icon-512.png"), pngAt(fullbleed, 512)),
    writeFile(
      join(pwaRoot, "icon-maskable-512.png"),
      pngAt(fullbleed, 512),
    ),
    writeFile(
      join(pwaRoot, "apple-touch-icon.png"),
      pngAt(fullbleed, 180),
    ),
  ]);
}

app.commandLine.appendSwitch("disable-gpu");
app.on("window-all-closed", () => {});
void app.whenReady().then(async () => {
  app.dock?.hide();
  await render();
  app.quit();
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
