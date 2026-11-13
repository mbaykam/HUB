import { desktopCapturer, screen } from "electron";

export async function capturePrimaryDisplay(): Promise<Buffer> {
  const display = screen.getPrimaryDisplay();
  const width = display.size.width * display.scaleFactor;
  const height = display.size.height * display.scaleFactor;
  const scale = Math.min(1, 2560 / Math.max(width, height));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
  const primary = sources.find(source => source.display_id === String(display.id)) ??
    (screen.getAllDisplays().length === 1 && sources.length === 1 ? sources[0] : undefined);
  const thumbnail = primary?.thumbnail;
  if (!thumbnail || thumbnail.isEmpty()) throw new Error("Windows did not return a primary display image");

  const bitmap = thumbnail.toBitmap();
  const hasDetail = bitmap.some((value, index) => index % 4 !== 3 && value !== bitmap[index % 4]);
  if (!hasDetail) throw new Error("Windows returned a blank desktop image");
  return thumbnail.toPNG();
}
