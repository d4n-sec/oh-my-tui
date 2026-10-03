// End-to-end terminal check: create a tmux-backed session per machine, attach,
// and verify real command execution (output differs from typed input).
//
//   BASE_URL=http://localhost:8080 DEMO_PASSWORD=changeme123 node terminal-check.mjs
import { BASE, login, machines, createSession, closeSession, TerminalClient } from "./helper.mjs";

const cookie = await login();
const list = (await machines(BASE, cookie)).machines;
console.log(`machines: ${list.map((m) => `${m.name}(${m.mode})`).join(", ")}`);

let failures = 0;
for (const machine of list) {
  if (!machine.terminalReady) {
    console.log(`- ${machine.name}: 跳过（终端未就绪）`);
    continue;
  }
  let session = null;
  let client = null;
  try {
    session = (await createSession(BASE, cookie, machine.id, { title: `check-${machine.name}` })).session;
    client = new TerminalClient(BASE, cookie, session.id, { cookie });
    await client.connect();
    client.send("printf 'OTM-%s\\n' \"$((111+222))\"\r");
    await client.waitFor("OTM-333");
    console.log(`✓ ${machine.name} [${machine.mode}] 会话 ${session.id} 命令执行成功`);
  } catch (err) {
    failures += 1;
    console.log(`✗ ${machine.name} [${machine.mode}] 失败：${err.message}`);
  } finally {
    client?.close();
    if (session) await closeSession(BASE, cookie, session.id).catch(() => undefined);
  }
}
process.exit(failures === 0 ? 0 : 1);
