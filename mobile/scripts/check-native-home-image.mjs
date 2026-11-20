import sharp from 'sharp';

const file = process.argv[2];
const {data, info} = await sharp(file).removeAlpha().resize(160, 320, {fit: 'fill'}).raw().toBuffer({resolveWithObject: true});
let workspacePixels = 0;
let controlPixels = 0;
let bottomControls = 0;
for (let y = 32; y < 304; y++) {
  for (let x = 10; x < 155; x++) {
    const i = (y * info.width + x) * info.channels;
    const [r, g, b] = data.subarray(i, i + 3);
    // HUB's plain charcoal backdrop and cards (a little blue, never pure black).
    if (r >= 6 && r < 45 && g >= r && b > g && b <= 60) workspacePixels++;
    if (r >= 140 && g >= 140 && b >= 165) controlPixels++;
    if (y > 255 && r >= 105 && g >= 105 && b >= 125) bottomControls++;
  }
}
if (workspacePixels < 6_000 || controlPixels < 65 || bottomControls < 5) {
  console.error(JSON.stringify({workspacePixels, controlPixels, bottomControls}));
  process.exitCode = 1;
}
