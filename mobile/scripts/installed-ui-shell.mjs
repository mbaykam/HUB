import { parse } from "acorn";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

/** Installed-document-only transform; input bytes/ordinary PWA remain unchanged. */
export function transformInstalledUIShell(source) {
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const methods = [];
  walk(tree, node => {
    if (node.type === "MethodDefinition" && !node.computed && node.key.type === "Identifier" && node.key.name === "runPluginBoot") methods.push(node);
  });
  const method = methods[0], fn = method?.value;
  if (methods.length !== 1 || !fn.async || fn.params.length !== 2 || fn.params.some(param => param.type !== "Identifier")) {
    throw new Error("Installed UI shell boot method drift");
  }
  const parameter = fn.params[1].name, barriers = [], references = [], calls = [];
  walk(fn.body, node => {
    if (node.type === "Identifier" && node.name === parameter) references.push(node);
    if (node.type === "AwaitExpression" && node.argument.type === "Identifier" && node.argument.name === parameter) barriers.push(node);
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed) calls.push(node.callee);
  });
  const count = name => calls.filter(call => call.property.type === "Identifier" && call.property.name === name).length;
  if (barriers.length !== 1 || references.length !== 1 || count("create") !== 1 || count("await") !== 1 ||
      calls.filter(call => call.object.type === "ThisExpression" && call.property.name === "assertEntriesActive").length !== 1) {
    throw new Error("Installed UI shell prefetch/audit boundary drift");
  }
  const barrier = barriers[0];
  // Replace only the expression, including when Vite uses a comma sequence.
  // The installed document manifest hashes these resulting bytes; no existing
  // Vite content-addressed asset is overwritten or served with stale identity.
  const result = source.slice(0, barrier.start) + "void 0" + source.slice(barrier.end);
  parse(result, { ecmaVersion: "latest", sourceType: "module" });
  return result;
}
