// ui.js — terminal bits shared by the CLI and the installer.

// The CLI entry, as users type it from the checkout (used in hints).
export const CLI = "node bin/cli.mjs";

export function banner() {
  // ANSI colors only when stdout is a TTY (avoid junk in logs/pipes).
  const tty = process.stdout.isTTY;
  const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const blue = (s) => c("38;5;33", s); // Zalo blue
  const cyan = (s) => c("36", s);
  const dim = (s) => c("2", s);
  console.log(
    "\n" +
    blue("  ╦ ╦┌─┐┬─┐┌┬┐┌─┐┌─┐  ") + cyan("╔═╗┌─┐┬  ┌─┐") + "\n" +
    blue("  ╠═╣├┤ ├┬┘│││├┤ └─┐  ") + cyan("╔═╝├─┤│  │ │") + "\n" +
    blue("  ╩ ╩└─┘┴└─┴ ┴└─┘└─┘  ") + cyan("╚═╝┴ ┴┴─┘└─┘") + "\n" +
    dim("  Hermes × Zalo plugin") + "\n" +
    dim("  chat with your Hermes agent from Zalo") + "\n",
  );
}
