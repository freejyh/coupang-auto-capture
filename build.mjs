import fs from "node:fs/promises";

await fs.rm("public", { recursive: true, force: true });
await fs.mkdir("public", { recursive: true });

for (const file of ["index.html", "result.json", "_headers"]) {
  await fs.copyFile(file, `public/${file}`);
}

console.log("Build complete: public/");
