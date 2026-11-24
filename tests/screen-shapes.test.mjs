import test from "node:test";
import assert from "node:assert/strict";
import {parseScreenShapes} from "../packages/harness-overlay/src/host/voice-screen.ts";

test("screen highlights take aim lines and target circles, validated", () => {
  const shapes = parseScreenShapes(
    [{points: [[0.2, 0.7], [0.5, 0.4], [0.8, 0.2]], style: "dashed", label: "Bank shot"}, {points: [[0.1, 0.1], [0.3, 0.3]]}],
    [{x: 0.5, y: 0.4, radius: 0.03, label: "Ghost ball"}]);
  assert.equal(shapes.paths.length, 2);
  assert.equal(shapes.paths[1].style, "arrow");
  assert.equal(shapes.circles[0].label, "Ghost ball");
  assert.deepEqual(parseScreenShapes(undefined, undefined), {});
  assert.throws(() => parseScreenShapes([{points: [[0.2, 0.2]]}], undefined), /2 to 6 points/);
  assert.throws(() => parseScreenShapes([{points: [[0.2, 1.4], [0.3, 0.3]]}], undefined), /between 0 and 1/);
  assert.throws(() => parseScreenShapes([{points: [[0.1, 0.1], [0.2, 0.2]], style: "zigzag"}], undefined), /arrow, line or dashed/);
  assert.throws(() => parseScreenShapes(undefined, [{x: 0.5, y: 0.5, radius: 0}]), /radius/);
});
