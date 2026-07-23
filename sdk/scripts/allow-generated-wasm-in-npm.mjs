import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const npmIgnore = fileURLToPath(
  new URL("../pkg/.npmignore", import.meta.url),
);

// wasm-pack writes `pkg/.gitignore` containing `*`. npm otherwise honors that
// file and silently omits the generated WASM from @fiducia/sync's tarball.
await writeFile(npmIgnore, "# Include every wasm-pack artifact in the parent npm package.\n");
