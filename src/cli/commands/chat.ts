// grove chat "message" — Send a message to the orchestrator
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";

export async function run(args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  const text = args.join(" ").replace(/^["']|["']$/g, "");
  if (!text) {
    console.log(`${pc.red("Usage:")} grove chat "your message"`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await resp.json() as any;

    if (data.ok) {
      console.log(`${pc.green("✓")} Message sent to orchestrator`);
      console.log(`${pc.dim("View the response in tmux: tmux attach -t grove")}`);
    } else {
      console.log(`${pc.red("Error:")} ${data.error}`);
    }
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}
