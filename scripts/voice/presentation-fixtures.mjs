export const staticPresentation = {
  title: "One conversation, two inputs", kind: "html",
  html: '<h1>One conversation</h1><p>Voice and text share the same context.</p><svg viewBox="0 0 320 160" role="img" aria-label="Voice and text connect to one hub"><rect x="10" y="20" width="110" height="45" rx="14" fill="#344365"/><text x="30" y="48" fill="white">Voice</text><rect x="10" y="95" width="110" height="45" rx="14" fill="#344365"/><text x="30" y="123" fill="white">Text</text><path d="M120 43L200 80M120 117L200 80" stroke="#86d6bd" stroke-width="3"/><circle cx="247" cy="80" r="45" fill="#273d4a"/><text x="228" y="86" fill="white">HUB</text></svg>',
};
export const interactivePresentation = {
  title: "Explore a square", kind: "vega",
  spec: { width: 300, height: 260, padding: 12, background: "#0e1324",
    signals: [{ name: "side", value: 6, bind: { input: "range", min: 1, max: 10, step: 1, name: "Side length " } }],
    marks: [
      { type: "rect", encode: { update: { x: { value: 30 }, y: { value: 20 }, width: { signal: "side * 18" }, height: { signal: "side * 18" }, fill: { value: "#87cab8" }, cornerRadius: { value: 8 } } } },
      { type: "text", encode: { update: { x: { value: 30 }, y: { value: 240 }, text: { signal: "'Area: ' + side * side" }, fill: { value: "#eef0fa" }, fontSize: { value: 22 } } } },
    ],
  },
};

export const interactivePlanPresentation = {
  title: "Explore a daily plan", kind: "vega",
  spec: { width: 260, height: 160, background: "#111827",
    signals: [{ name: "breakMinutes", value: 10, bind: { input: "range", min: 0, max: 20, step: 1 } }],
    data: [{ name: "plan", values: [{ task: "Reading", minutes: 5 }, { task: "Coding", minutes: 15 }, { task: "Break", minutes: 10 }], transform: [{ type: "formula", as: "displayMinutes", expr: "datum.task === 'Break' ? breakMinutes : datum.minutes" }] }],
    scales: [{ name: "x", type: "band", domain: { data: "plan", field: "task" }, range: "width", padding: .25 }, { name: "y", type: "linear", domain: [0, 20], range: "height" }],
    marks: [
      { type: "rect", from: { data: "plan" }, encode: { enter: { fill: { value: "#87cab8" } }, update: { x: { scale: "x", field: "task" }, width: { scale: "x", band: 1 }, y: { scale: "y", field: "displayMinutes" }, y2: { scale: "y", value: 0 } } } },
      { type: "text", from: { data: "plan" }, encode: { update: { x: { scale: "x", field: "task", band: .5 }, y: { scale: "y", field: "displayMinutes", offset: -6 }, text: { signal: "datum.displayMinutes + ' min'" }, fill: { value: "#eef0fa" } } } },
    ],
  },
};

export const calculatorPresentation = {
  title: "Calculator", kind: "vega",
  spec: { width: 300, height: 160, background: "#101727",
    signals: [
      { name: "left", value: 7, bind: { input: "number", name: "First number " } },
      { name: "operation", value: "+", bind: { input: "select", options: ["+", "−", "×", "÷"], name: "Operation " } },
      { name: "right", value: 5, bind: { input: "number", name: "Second number " } },
      { name: "answer", update: "operation === '+' ? toNumber(left) + toNumber(right) : operation === '−' ? left - right : operation === '×' ? left * right : toNumber(right) === 0 ? 'Cannot divide by zero' : left / right" },
    ],
    marks: [
      { type: "text", encode: { update: { x: { value: 18 }, y: { value: 38 }, text: { value: "CALCULATOR" }, fill: { value: "#adbfe5" }, fontSize: { value: 13 } } } },
      { type: "text", encode: { update: { x: { value: 18 }, y: { value: 98 }, text: { signal: "'' + answer" }, fill: { value: "#eaf2ff" }, fontSize: { signal: "isNumber(answer) ? 38 : 18" } } } },
    ],
  },
};
