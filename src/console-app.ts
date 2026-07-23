import { Engine } from "./engine.js";
import { render } from "./render.js";
import type { DiscoveredSession } from "./types.js";

const ONCE = process.argv.includes("--once");

async function main(): Promise<void> {
  const engine = new Engine();

  if (ONCE) {
    await engine.scan();
    render(engine.aircraft(), Date.now(), false);
    return;
  }

  engine.on("update", (list: DiscoveredSession[]) => render(list, Date.now(), true));
  await engine.start();

  process.on("SIGINT", async () => {
    await engine.stop();
    process.stdout.write("\n  ✈  cleared for landing. bye.\n\n");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("console-app failed:", err);
  process.exit(1);
});
