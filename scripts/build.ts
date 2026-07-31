import { z } from "zod";

const packageManifest = z.object({
  version: z.string().min(1),
});

const { version } = packageManifest.parse(
  await Bun.file(new URL("../package.json", import.meta.url)).json(),
);

const output = await Bun.build({
  entrypoints: ["src/main.ts"],
  minify: true,
  sourcemap: "inline",
  define: { __APP_VERSION__: JSON.stringify(version) },
  compile: {
    outfile: "dist/asana-cli",
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
});

if (!output.success) {
  throw new AggregateError(output.logs, "Failed to build asana-cli");
}
