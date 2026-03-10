// Grove v2 — Interactive prompts (@clack/prompts wrappers)
import * as clack from "@clack/prompts";
import { die } from "./ui";

/** Y/N confirmation prompt. Returns true for yes. */
export async function confirm(message: string, defaultValue: boolean = false): Promise<boolean> {
  const result = await clack.confirm({ message, initialValue: defaultValue });
  if (clack.isCancel(result)) {
    die("Operation cancelled.");
  }
  return result as boolean;
}

/** Select from a list of options. Returns the selected value. */
export async function choose<T extends string>(
  message: string,
  options: { value: T; label: string; hint?: string }[]
): Promise<T> {
  const result = await clack.select({ message, options });
  if (clack.isCancel(result)) {
    die("Operation cancelled.");
  }
  return result as T;
}

/** Text input prompt. Returns the entered string. */
export async function text(
  message: string,
  options?: { placeholder?: string; defaultValue?: string; validate?: (value: string) => string | void }
): Promise<string> {
  const result = await clack.text({
    message,
    placeholder: options?.placeholder,
    defaultValue: options?.defaultValue,
    validate: options?.validate,
  });
  if (clack.isCancel(result)) {
    die("Operation cancelled.");
  }
  return result as string;
}

/** Multi-select from a list. Returns array of selected values. */
export async function multiselect<T extends string>(
  message: string,
  options: { value: T; label: string; hint?: string }[]
): Promise<T[]> {
  const result = await clack.multiselect({ message, options, required: false });
  if (clack.isCancel(result)) {
    die("Operation cancelled.");
  }
  return result as T[];
}

/** Simple numbered menu for HUD-style selection (raw, no @clack). */
export async function numberedMenu(
  prompt: string,
  options: string[]
): Promise<number> {
  console.log(prompt);
  for (let i = 0; i < options.length; i++) {
    console.log(`  [${i + 1}] ${options[i]}`);
  }

  const rl = await import("node:readline");
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<number>((resolve) => {
    const ask = () => {
      iface.question("Choice: ", (answer) => {
        const num = parseInt(answer, 10);
        if (num >= 1 && num <= options.length) {
          iface.close();
          resolve(num - 1);
        } else {
          console.log(`Please enter a number between 1 and ${options.length}.`);
          ask();
        }
      });
    };
    ask();
  });
}
