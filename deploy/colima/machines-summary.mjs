// Summarize GET /api/machines output from stdin.
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let data = {};
  try {
    data = JSON.parse(input);
  } catch {
    /* leave empty */
  }
  const machines = Array.isArray(data.machines) ? data.machines : [];
  console.log(`READY=${machines.filter((m) => m.terminalReady).length}`);
  for (const m of machines) {
    const ssh = m.sshHost ? `${m.sshHost}:${m.sshPort ?? "-"}` : "via tunnel";
    console.log(
      `  - ${String(m.name).padEnd(15)} status=${String(m.status).padEnd(8)} mode=${String(m.mode).padEnd(7)}` +
        ` terminalReady=${m.terminalReady} ssh=${ssh} user=${m.username ?? "-"}`,
    );
  }
});
