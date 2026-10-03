import { start } from "./index";
import { runAdmin } from "./admin";

const ADMIN_COMMANDS = new Set(["setup-token", "reset-owner", "status"]);

const HELP = `terminal-server — Oh-My-TUI Server

用法:
  terminal-server                     启动服务端（WEB + AGENT 两个监听）
  terminal-server setup-token         生成一次性初始化 Token
  terminal-server reset-owner [--yes] 清除所有者（本地恢复）
  terminal-server status              打印服务端状态
  terminal-server help                显示本帮助

环境变量:
  DOCKER_ENV=1        绑定 0.0.0.0（容器内需要）；否则默认绑定 127.0.0.1
  WEB_LISTEN_HOST / AGENT_LISTEN_HOST   分别覆盖监听地址
  WEB_PORT / AGENT_PORT                 监听端口（默认 8080 / 8443）
  WEB_ORIGIN / AGENT_ORIGIN             公网来源
  AGENT_CONNECT_HOST / AGENT_CONNECT_PORT  生成客户端命令时使用的回连地址
  DATA_DIR            数据目录 (默认 ./data)
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "start") {
    await start();
    return;
  }
  if (ADMIN_COMMANDS.has(command)) {
    await runAdmin(args);
    return;
  }
  if (["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
    return;
  }
  console.error(`未知命令：${command}\n`);
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
