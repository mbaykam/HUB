/** Nonprivileged UX hint only. It grants no authority and exposes no native
 * handler/credentials. The fixed link asks UIKit to show its own confirmation. */
export function createNativeVoiceEntry(root:Document):HTMLAnchorElement|undefined{
  const view=root.defaultView;
  if(!view||!/(?:^|\s)HUBiOS\/\d+\.\d+(?:\.\d+)?(?:\s|$)/.test(view.navigator.userAgent)||view.location.protocol!=="https:")return;
  const link=root.createElement("a");link.href=new URL("/?hubNative=voice",view.location.origin).href;
  link.setAttribute("data-voice-start","");link.setAttribute("data-native-voice-entry","");link.setAttribute("aria-label","Open iPhone voice controls");
  link.title="Open Voice in the iPhone app";
  const title=root.createElement("strong");title.textContent="Speak";
  const glyph=root.createElement("span");glyph.setAttribute("data-voice-glyph","");glyph.setAttribute("aria-hidden","true");
  for(let i=0;i<5;i++)glyph.append(root.createElement("i"));
  link.append(title,glyph);return link;
}

/** Settings-only entry supported by the header-free native client. UA is a
 * display hint; UIKit independently validates the exact user-activated link. */
export function createNativeOptionsEntry(root:Document):HTMLAnchorElement|undefined{
  const view=root.defaultView;
  const version=view?.navigator.userAgent.match(/(?:^|\s)HUBiOS\/(\d+)\.(\d+)(?:\.\d+)?(?:\s|$)/);
  if(!view||view.location.protocol!=="https:"||!version||Number(version[1])===0&&Number(version[2])<2)return;
  const link=root.createElement("a");
  link.href=new URL("/?hubNative=options",view.location.origin).href;
  link.textContent="iPhone";link.setAttribute("data-native-options-entry","");
  link.setAttribute("aria-label","iPhone settings");link.title="Voice, notifications, files and connection";
  return link;
}
