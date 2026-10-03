import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { Store } from "./store";
import { randomToken, sha256 } from "./crypto";

function usage(): never {
  console.log(`Oh-My-TUI Server 管理命令

用法:
  terminal-server setup-token              生成一次性初始化 Token（服务端未初始化时）
  terminal-server reset-owner [--yes]      清除所有者与全部浏览器会话（本地恢复用）
  terminal-server status                   打印服务端状态

环境变量:
  DATA_DIR        数据目录 (默认 ./data)
`);
  process.exit(1);
}

export async function runAdmin(argv: string[]): Promise<void> {
  const command = argv[0];
  const config = loadConfig();
  const db = openDatabase(path.join(config.dataDir, "server.db"));
  const store = new Store(db);

  switch (command) {
    case "setup-token": {
      if (store.isInitialized()) {
        console.error("服务端已初始化。若要重新初始化，请先运行 reset-owner。");
        process.exit(2);
      }
      const token = randomToken(24);
      const now = Date.now();
      store.replaceSetupToken(sha256(token), now, now + config.setupTokenTtlMs);
      const file = path.join(config.dataDir, "setup-token.txt");
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, token + "\n", { mode: 0o600 });
      console.log("一次性初始化 Token（%d 分钟内有效，仅显示一次）:", Math.floor(config.setupTokenTtlMs / 60_000));
      console.log("  %s", token);
      console.log("已写入 %s (0600)。请在浏览器打开 %s 完成初始化。", file, config.webOrigin);
      break;
    }
    case "reset-owner": {
      if (argv[1] !== "--yes") {
        console.error("此操作会删除所有者与全部浏览器会话。确认请加 --yes。");
        process.exit(2);
      }
      store.deleteOwner();
      store.deleteSessionsForOwner();
      console.log("已清除所有者。请运行 setup-token 生成初始化 Token 后重新初始化。");
      break;
    }
    case "status": {
      const owner = store.getOwner();
      const machines = store.listMachines();
      console.log("数据目录: %s", config.dataDir);
      console.log("已初始化: %s", store.isInitialized() ? "是" : "否");
      console.log("所有者创建时间: %s", owner ? new Date(owner.created_at).toISOString() : "-");
      console.log("机器数量: %d", machines.length);
      for (const m of machines) {
        console.log(
          "  - %s (%s) mode=%s lastSeen=%s",
          m.name,
          m.id,
          m.mode,
          m.last_seen_at ? new Date(m.last_seen_at).toISOString() : "-",
        );
      }
      break;
    }
    default:
      usage();
  }
}

if (require.main === module && /[/\\]admin\.js$/.test(require.main.filename)) {
  runAdmin(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
