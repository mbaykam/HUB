import { symlink } from "node:fs/promises";

/** File symlinks require Developer Mode or elevation on some Windows hosts.
 * Keep the filesystem check real; skip only when the OS denies its fixture.
 * Linux/macOS CI exercises the same test without this privilege requirement. */
export async function createFileSymlink(t, target, link) {
  try {
    await symlink(target, link, "file");
    return true;
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
    t.skip("This Windows account cannot create file symlinks; exercised on Unix CI.");
    return false;
  }
}
