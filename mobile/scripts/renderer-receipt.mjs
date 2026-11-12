/** Validate fresh, app-written evidence against the exact renderer already tested by UIKit. */
export function validateRendererReceipt(proof, {nonce, documentSHA256, manifestSHA256, documentBytes}) {
  if (proof?.receiptNonce!==nonce||proof.sourceSHA256!==documentSHA256||proof.manifestSHA256!==manifestSHA256||proof.sourceBytes!==documentBytes||proof.realRendered!==true||proof.nativeBridge!==false||proof.nonPersistent!==true||proof.testOnlyCSP!==true||proof.error||proof.receiptWriteError) throw Error("Renderer receipt does not match fresh verified app content");
  const renderer=proof.renderer,rects=[renderer?.composer,renderer?.menu,renderer?.voice,renderer?.send];
  if(renderer?.home!==true||renderer.compact!==true||rects.some(rect=>rect?.visible!==true)||![renderer.composer.height,renderer.menu.right,renderer.voice.x,renderer.voice.right,renderer.send.x].every(Number.isFinite)||!(renderer.composer.height>0&&renderer.composer.height<=80)||!(renderer.menu.right<=renderer.voice.x&&renderer.voice.right<=renderer.send.x))throw Error("Fresh renderer receipt failed actual UI geometry");
  return proof;
}
