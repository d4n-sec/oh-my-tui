// Print one JSON field from stdin: node json-field.mjs <key>
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(input)[process.argv[2]];
    console.log(value === undefined || value === null ? "" : String(value));
  } catch {
    console.log("");
  }
});
